/**
 * dsh-better-workspace — host half (plain JavaScript, no build step).
 *
 * The browser features live in the client half (src/client.js). This host
 * half owns the Windows-only server-side pieces (v0.37.0+): the Explorer
 * "Open as workspace" context-menu registration, the DSH_HOME inbox watcher
 * that adopts picked directories through the official workspace/session
 * services, and (v0.37.1) the settings-namespace signal that tells the
 * client to reveal the adopted session. Side effects are confined to
 * apply(), gated to win32, and entirely best-effort (never row-fatal).
 */
import { watch } from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dsh-better-workspace'

/**
 * dsh >= 0.1.7 marks a Config field live-editable without remount; a
 * 0.1.6-era schemastery predates the method and the guard keeps this module
 * loadable there (values then behave as ordinary config, read through the
 * registered settings namespace instead).
 */
function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * The schemastery module, resolved LAZILY (0.21.1): `@deepseek-ai/schemastery`
 * is a PEER, so a profile whose `node_modules` does not hoist it — the desktop
 * app's bundled runtime, or any install that resolved the peers elsewhere —
 * used to fail the *static* import at the top of this file. The Loader treats a
 * failed plugin import as a non-fatal skip (`ctx.logger.error` + no fiber), so
 * the row silently never mounted: no host half, no `dsh.client` scan, no client
 * bundle in the boot graph, and the official sidebar quietly took the seat —
 * the same all-green-log failure class as issue #9, reproduced on a clean
 * isolated DSH_HOME. Deferring the import hides the schema where the module is
 * absent instead of killing the row; on a host that has it (every dsh install
 * that serves the settings surface) nothing changes. Null when unresolvable.
 */
let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch (error) {
  Schema = null
  console.warn(
    '[dsh-better-workspace] @deepseek-ai/schemastery is not resolvable here; the row Config surface is absent'
    + ' (the browser features do not depend on it): ' + (error && error.message || String(error)),
  )
}

/**
 * Row Config = the settings surface on dsh >= 0.1.7 (values persist under the
 * row id 'better-workspace' — the same string as the old settings namespace,
 * so the one-shot legacy settings.yaml import maps old user values onto the
 * new home). Inert metadata on older hosts, and absent when schemastery is
 * unresolvable (cordis then passes the row config through unvalidated; the
 * browser half reads every value with its own fallbacks either way).
 * NOTE: settings are per-profile on the new host; the client hides the manual
 * cross-device sync section accordingly (the shared settings.yaml home no
 * longer exists).
 */
export const Config = Schema === null
  ? undefined
  : Schema.object({
    compactChains: live(Schema.boolean().default(true)),
    statusPulse: live(Schema.boolean().default(true)),
    styling: live(Schema.dict(Schema.any()).default({})),
    appearance: live(Schema.dict(Schema.any()).default({})),
    // v0.37.1: transient host->client signal for the Explorer "Open as
    // workspace" adoption (the client watches it through the configForms
    // mirror and reveals the new session). Transient by contract — never one
    // of the manual cross-device sync fields.
    explorerOpen: live(Schema.dict(Schema.any()).default({})),
  })

/** Read one Config value across eras: Volatile ref (>= 0.1.7) or plain value. */
export function valueOf(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/**
 * Explorer "Open as workspace" (v0.37.0, Windows only).
 *
 * Two host-side halves, no client code involved:
 *
 * ① Registration — an HKCU context-menu entry on folders
 *    (HKCU\Software\Classes\Directory\shell\DSH.BetterWorkspace.Open\command)
 *    runs scripts/open-in-dsh.ps1, which appends the picked directory as ONE
 *    LINE to <DSH_HOME>\better-workspace-open-inbox.txt and then opens
 *    dsh://open — the desktop shell registers the dsh protocol and its
 *    second-instance handler focuses the running window (or launches the app).
 *    HKCU needs no elevation and the entry survives app restarts; it is the
 *    same mechanism ChatGPT's "Open project in ChatGPT" uses.
 *
 * ② Adoption — the host half watches the inbox directory and, per drain,
 *    RENAMES the inbox to a per-process claim file before reading it. The
 *    rename is atomic-ish and fails while a writer holds the file, so every
 *    line is processed exactly once even with several host processes watching
 *    (desktop + web profile share one DSH_HOME). Each line is adopted through
 *    the SAME two services the GUI "add workspace" flow rides:
 *    workspaceRegistry.resolveByPath (reuse) -> create (create-or-reuse by
 *    canonical path, prepends to the registry order) and
 *    sessionController.create({ workspaceId }) (creates or reuses the blank
 *    member session, attaches it). Replays after a crash stay harmless.
 *
 * Known limit: the host cannot switch the client's current session — the new
 * blank session simply appears in the sidebar tree of the focused window.
 */

/** Registry leaf under HKCU\Software\Classes\Directory\shell. */
export const EXPLORER_MENU_KEY = 'DSH.BetterWorkspace.Open'

/** Menu label written into the registry value. */
export const EXPLORER_MENU_TEXT = '作为工作区在 DeepSeek Harness 中打开'

/** Inbox file inside DSH_HOME; one absolute directory path per line. */
export const EXPLORER_INBOX_NAME = 'better-workspace-open-inbox.txt'

/** Resolve DSH_HOME the way the host does (env wins, ~/.dsh fallback). */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** .reg value escaping: backslashes double, quotes escape (reg file format). */
export function escapeRegValue(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Assemble the .reg file content (pure; smoke-tested directly). The file is
 * written UTF-16LE with BOM — that is what lets reg.exe import non-ASCII menu
 * text without a codepage round-trip.
 */
export function buildExplorerMenuReg({ menuText, iconPath, command }) {
  const base = 'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\' + EXPLORER_MENU_KEY
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    '[' + base + ']',
    '@="' + escapeRegValue(menuText) + '"',
  ]
  if (iconPath) lines.push('"Icon"="' + escapeRegValue(iconPath) + '"')
  lines.push('', '[' + base + '\\command]', '@="' + escapeRegValue(command) + '"', '')
  return lines.join('\r\n')
}

/**
 * Import the Explorer menu entry into HKCU. Idempotent by construction (reg
 * import overwrites values). The Icon value only makes sense when this host
 * process IS the desktop app — under a plain node web host execPath is the
 * node binary, so the menu is registered without an icon there.
 */
async function registerExplorerMenu(log) {
  const launcherPath = fileURLToPath(new URL('../scripts/open-in-dsh.vbs', import.meta.url))
  const inboxPath = join(dshHome(), EXPLORER_INBOX_NAME)
  // v0.37.1: launch through the wscript GUI-subsystem wrapper — Explorer
  // starts verb commands with SW_SHOWNORMAL, so invoking powershell.exe
  // directly flashes a console window even with -WindowStyle Hidden; the vbs
  // (run via wscript.exe, style 0) shows nothing at all. The ps1 stays the
  // worker; the vbs only forwards %1 and the inbox path.
  const command = 'wscript.exe "' + launcherPath + '" "%1" "' + inboxPath + '"'
  const iconPath = process.versions && process.versions.electron ? process.execPath : undefined
  const reg = buildExplorerMenuReg({ menuText: EXPLORER_MENU_TEXT, iconPath, command })
  const temp = join(tmpdir(), 'dsh-better-workspace-menu-' + process.pid + '.reg')
  await fsp.writeFile(temp, '\uFEFF' + reg, 'utf16le')
  try {
    await execFileAsync('reg.exe', ['import', temp])
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {})
  }
  log('[dsh-better-workspace] explorer menu registered (HKCU): ' + EXPLORER_MENU_KEY)
}

/**
 * Watch the inbox and adopt every queued directory. Returns a disposer.
 * Never throws: every failure is logged and retried on the next event.
 */
function startExplorerOpenWatcher(ctx, log) {
  const inboxPath = join(dshHome(), EXPLORER_INBOX_NAME)
  let services = null
  let settingsController = null
  let pending = []
  let draining = false

  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry', 'sessionController'], (sctx) => {
      services = sctx
      if (pending.length > 0) void drain(pending)
      pending = []
    })
    // v0.37.1: publish adoptions to the client through the settings
    // namespace. settingsController.update merges one field into the stored
    // user section; the configForms mirror re-derives from it, so the
    // client-side form subscription fires with the new token. Absent on old
    // hosts — then the adoption simply stays silent, the pre-0.37.1 behavior.
    ctx.inject(['settingsController'], (sctx) => {
      settingsController = sctx && sctx.settingsController
    })
  }

  /**
   * Tell the client to reveal the just-adopted session: one volatile
   * { token, workspaceId, sessionId } under the 'better-workspace' namespace.
   * Best-effort by design; a failed publish never fails the adoption.
   */
  function publishExplorerOpen(workspaceId, sessionId) {
    const controller = settingsController
    if (!controller || typeof controller.update !== 'function' || !sessionId) return
    const token = {
      token: randomUUID(),
      workspaceId: String(workspaceId),
      sessionId: String(sessionId),
      at: new Date().toISOString(),
    }
    void Promise.resolve(controller.update('better-workspace', { explorerOpen: token })).catch((error) => {
      log('[dsh-better-workspace] explorerOpen publish failed (non-fatal): '
        + (error && error.message || String(error)))
    })
  }

  const qualified = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')

  async function adoptLine(raw) {
    const path = String(raw || '').trim()
    if (!path || !qualified(path)) return
    const stat = await fsp.stat(path).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      log('[dsh-better-workspace] explorer-open skipped (not a directory): ' + path)
      return
    }
    const registry = services && services.workspaceRegistry
    const controller = services && services.sessionController
    if (!registry || typeof registry.create !== 'function'
      || !controller || typeof controller.create !== 'function') {
      pending.push(path)
      return
    }
    const existing = typeof registry.resolveByPath === 'function'
      ? await registry.resolveByPath(path).catch(() => undefined)
      : undefined
    const workspace = existing || await registry.create(path)
    const created = await controller.create({ workspaceId: workspace.id })
    log('[dsh-better-workspace] explorer-open adopted "' + path + '"'
      + ' -> workspace ' + workspace.id
      + ', session ' + (created && created.sessionId))
    publishExplorerOpen(workspace.id, created && created.sessionId)
  }

  async function drain(lines) {
    if (draining) return
    draining = true
    try {
      if (lines) {
        for (const line of lines) {
          try { await adoptLine(line) } catch (error) {
            log('[dsh-better-workspace] explorer-open failed for one line: '
              + (error && error.message || String(error)))
          }
        }
        return
      }
      // Claim the whole inbox by renaming it away; the rename fails while a
      // writer holds the file (Windows sharing), which simply retries later.
      const claim = inboxPath + '.claim-' + process.pid
      try { await fsp.rename(inboxPath, claim) } catch { return }
      let content = await fsp.readFile(claim, 'utf8').catch(() => '')
      content = content.replace(/^\uFEFF/, '')
      for (const line of content.split(/\r?\n/)) {
        try { await adoptLine(line) } catch (error) {
          log('[dsh-better-workspace] explorer-open failed for one line: '
            + (error && error.message || String(error)))
        }
      }
      await fsp.unlink(claim).catch(() => {})
    } finally {
      draining = false
    }
  }

  let closed = false
  let timer = null
  try { fsp.mkdir(dirname(inboxPath), { recursive: true }).catch(() => {}) } catch {}
  let watcher = null
  try {
    watcher = watch(dirname(inboxPath), (event, name) => {
      if (closed) return
      if (name && String(name).indexOf(EXPLORER_INBOX_NAME) === 0) void drain()
    })
    watcher.on('error', () => {})
  } catch { watcher = null }
  const arm = () => { if (!closed) timer = setTimeout(tick, 1500) }
  const tick = () => { void drain().finally(arm) }
  timer = setTimeout(tick, 1500)
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    if (watcher) watcher.close()
  }
}

export function apply(ctx) {
  const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
    ? (msg) => ctx.logger.info(msg)
    : (msg) => console.log(msg)
  log('[dsh-better-workspace] host half loaded; UI runs in the browser (client half)')
  if (!ctx || typeof ctx.inject !== 'function') return
  // Register the settings namespace so the browser card appears in
  // Settings → Plugins. The tab dispatches the intersection of served
  // namespaces and settings.plugin.item cards, and `settings` is a
  // cross-cutting service that may appear after this plugin's apply — so the
  // registration waits for its injection (the same pattern dsh-context uses).
  // The dsh-settings and zod modules resolve only through the dsh Loader; the
  // smoke test imports this file in plain Node with a logger-only ctx and
  // never reaches this path.
  // OLD-era namespace registration (dsh <= 0.1.6): the row Config above IS
  // the surface on dsh >= 0.1.7 — register() no longer exists there and this
  // block is skipped entirely.
  const legacySettings = (() => {
    try {
      const settings = ctx.get('settings')
      return !!(settings && typeof settings.register === 'function')
    } catch {
      return false
    }
  })()
  if (legacySettings) ctx.inject(['settings'], (sctx) => {
    log('[dsh-better-workspace] settings inject fired')
    // The settings service calls the schema AS A FUNCTION to resolve a value
    // (schema(mergeLayers(...))) — that is @deepseek-ai/schemastery's contract:
    // its schemas are callable and fill defaults on undefined. zod objects are
    // NOT callable, so a zod schema throws "TypeError: ... is not a function"
    // at register(); the namespace is then never served and the settings card
    // never gets data. The module resolves at runtime through normal Node
    // resolution from the plugin's own node_modules (the same static-import
    // pattern dsh-context uses).
    import('@deepseek-ai/schemastery')
      .then((sm) => {
        const settings = sctx && sctx.settings
        if (!settings || typeof settings.register !== 'function') return
        const Schema = sm.default
        // register() takes a plain string since dsh 0.1.2-alpha.2 removed the
        // settingsNamespace() helper (the helper was compile-time branding only).
        // The 0.1.6 floor guarantees the plain-string register() is what runs.
        settings.register('better-workspace', Schema.object({
          // Cross-device preferences live in the HOST settings store
          // (~/.dsh/settings.yaml): web and the desktop app share one
          // DSH_HOME, so appearance (styling) and the two toggles follow
          // the user across surfaces. Per-device view state (expansion) and
          // the cold-restart title cache stay browser-local.
          compactChains: Schema.boolean().default(true),
          statusPulse: Schema.boolean().default(true),
          styling: Schema.dict(Schema.any()).default({}),
          // Default appearance (color / glow / weight / shadow / outline) for
          // rows without their own entry — shared with the other surface like
          // the rest of the prefs. The client half owns the shape, so it stays
          // a permissive dict.
          appearance: Schema.dict(Schema.any()).default({}),
          // v0.37.1: same transient explorerOpen signal as the row Config
          // above (kept here so an old-era host does not strip the field).
          explorerOpen: Schema.dict(Schema.any()).default({}),
        }))
        log('[dsh-better-workspace] settings namespace registered: better-workspace')
      })
      .catch((error) => {
        log('[dsh-better-workspace] settings namespace registration FAILED: ' + (error && error.stack || String(error)))
      })
  })
  // Explorer "Open as workspace" (v0.37.0, Windows only, host side): register
  // the HKCU folder context-menu entry once per boot (idempotent — reg import
  // overwrites values) and watch the DSH_HOME inbox the menu command appends
  // to. Both are best-effort: a failure here must never take the row down.
  // The menu entry is deliberately NOT removed on dispose — it is what can
  // launch a closed DSH; scripts/unregister-explorer-menu.ps1 removes it.
  if (process.platform === 'win32') {
    void registerExplorerMenu(log).catch((error) => {
      log('[dsh-better-workspace] explorer menu registration failed (non-fatal): '
        + (error && error.message || String(error)))
    })
    const stopExplorerWatcher = startExplorerOpenWatcher(ctx, log)
    // Plugin teardown in this cordis generation is effect-based (the event
    // name is "internal/plugin", not a plain 'dispose'); ctx.effect's return
    // value is the disposer, the same pattern sessionController uses.
    if (typeof ctx.effect === 'function') ctx.effect(() => stopExplorerWatcher, 'explorer-open watcher')
  }
}
