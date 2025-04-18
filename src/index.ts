import createDebug from 'debug'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import c from 'picocolors'
import { spawnSync as $ } from 'picospawn'
import { concat, isObject, isString } from 'radashi'

const debug = createDebug('subrepo-install')
const log = (msg?: string) => console.log(msg ? c.magenta(c.italic(msg)) : '')

export interface Subrepo {
  /**
   * Where to clone the sub-repo.
   */
  dir: string
  /**
   * The remote URL of the sub-repo.
   */
  remote: string
  /**
   * The branch, tag, or commit hash to clone. Branches and tags are synced
   * every time `subrepo-install` is used.
   *
   * For commit hashes, it's recommended to use the full hash instead of a short
   * commit hash.
   *
   * If undefined, the default branch will be used, except when the sub-repo has
   * already been cloned (in which case, the current HEAD ref will be used).
   */
  ref?: string
  /**
   * List of relative paths to packages within the sub-repo. This ensures the
   * `node_modules` of each package are installed and their `build` script is
   * executed.
   *
   * Instead of a relative path, you may pass an object with a `name` that
   * differs from the name in the package's `package.json` configuration. Your
   * project must use this name when importing this package.
   */
  packages?: (string | { name: string; path: string })[]
  /**
   * What to do with the root package.
   *
   * - `ignore`: Do nothing with the root package.
   * - `install-only`: Install dependencies but don't build or link the root package.
   * - `default`: Treat the root package like any other package.
   */
  rootPackageStrategy?: 'ignore' | 'install-only' | 'default'
  /**
   * If a sub-repo exists elsewhere when in the context of a
   * workspace, you can link to this path instead of cloning.
   */
  workspaceOverride?: string
  /**
   * If a sub-repo has `node_modules` dependencies that you also want
   * in the `node_modules` of this repo, list them here.
   */
  inheritDependencies?: string[]
  /**
   * Create symlinks for files in the sub-repo to the root of this repo.
   */
  linkFiles?: Record<string, string>
}

export default function subrepoInstall(repos: Subrepo[]) {
  // These are node_modules roots.
  const workspaceRoot = $('pnpm root -w', { stdio: 'pipe', exit: false }).stdout
  const nearestRoot = $('pnpm root', { stdio: 'pipe', exit: false }).stdout

  debug(`Workspace root: ${workspaceRoot}`)
  debug(`Nearest root:   ${nearestRoot}`)

  const metadataPath = path.resolve(
    workspaceRoot || nearestRoot,
    '.subrepo-install/metadata.json'
  )

  const metadata = readJsonFile<Metadata>(metadataPath) ?? {}
  const previousHeads = { ...metadata.heads }

  for (const repo of repos) {
    let ref = repo.ref
    let head: string
    let usingWorkspaceOverride = false

    if (workspaceRoot && repo.workspaceOverride) {
      usingWorkspaceOverride = true
      ensureSymlink(repo.dir, repo.workspaceOverride)
    } else {
      let shouldUpdate = true

      if (existsSync(repo.dir)) {
        ref ??= $('git -C %s rev-parse --abbrev-ref HEAD', [repo.dir], {
          stdio: 'pipe',
        })

        head = $('git -C %s rev-parse HEAD', [repo.dir], {
          stdio: 'pipe',
        })

        const expectedHead = isCommitHash(ref)
          ? ref
          : $('git -C %s ls-remote origin %s', [repo.dir, ref], {
              stdio: 'pipe',
            }).slice(0, 40)

        if (head === expectedHead) {
          shouldUpdate = false
        }

        if (shouldUpdate) {
          log(`Syncing ${formatRelative(repo.dir)} package...`)
        }
      } else {
        log(`Cloning ${formatRelative(repo.dir)} package...`)
        $('git clone --depth 1', [repo.remote, repo.dir])
        log()
      }

      if (shouldUpdate && ref) {
        debug(`Fetching ref: ${ref}`)
        $('git -C %s fetch --depth 1 origin %s', [repo.dir, ref])
        log()

        debug(`Resetting to FETCH_HEAD...`)
        $('git -C %s reset --hard FETCH_HEAD', [repo.dir])
        log()
      }
    }

    head = $('git -C %s rev-parse HEAD', [repo.dir], {
      stdio: 'pipe',
    })

    // Used to reference this repo in the metadata.
    const repoKey = path.relative(
      path.dirname(workspaceRoot || nearestRoot),
      path.resolve(usingWorkspaceOverride ? repo.workspaceOverride! : repo.dir)
    )

    const repoIsWorkspace = isWorkspace(repo.dir)

    const rootPackageStrategy = repo.rootPackageStrategy ?? 'default'
    const rootPackageId =
      rootPackageStrategy !== 'ignore' &&
      existsSync(path.join(repo.dir, 'package.json'))
        ? '.'
        : null

    for (const pkgRef of concat(rootPackageId, repo.packages)) {
      const pkgFileName = isString(pkgRef) ? pkgRef : pkgRef.path
      const pkgDir = path.join(repo.dir, pkgFileName)

      const pkg = readPackageJson(pkgDir)
      if (!pkg) {
        console.warn(
          c.yellow('⚠️  Failed to read package.json for %s'),
          formatRelative(pkgDir)
        )
        continue
      }

      /** Used to reference this package in the metadata. */
      const pkgKey = path.join(repoKey, pkgFileName)

      /** The last commit hash for this package. */
      const pkgHead = $(
        'git --no-pager -C %s log -n 1 --pretty=format:%H',
        [repo.dir, pkgFileName],
        { stdio: 'pipe' }
      )

      /** Whether the last commit hash for this package has changed. */
      const pkgHeadChanged = pkgHead !== metadata.heads?.[pkgKey]

      /** The local name of the package. */
      const pkgLocalName = isString(pkgRef) ? pkg.name : pkgRef.name

      let shouldTrackHead = false

      if (
        (pkg.dependencies || pkg.devDependencies) &&
        (pkgFileName === '.' ? !usingWorkspaceOverride : !isWorkspace(repo.dir))
      ) {
        shouldTrackHead = true
        if (pkgHeadChanged) {
          log(`Installing dependencies for ${pkgDir}...`)
          $('pnpm -C %s install', [
            pkgDir,
            // Avoid generating a lockfile if none exists yet.
            !hasLockfile(pkgDir) && '--no-lockfile',
            // Avoid using a workspace unrelated to this clone.
            !repoIsWorkspace && !isWorkspace(pkgDir) && '--ignore-workspace',
          ])
          log()
        }
      }

      if (pkgFileName !== '.' || rootPackageStrategy !== 'install-only') {
        if (pkg.scripts?.build) {
          shouldTrackHead = true
          if (pkgHeadChanged) {
            log(`Building ${formatRelative(pkgDir)}...`)
            $('pnpm -C %s run build', [pkgDir])
            log()
          }
        }

        if (pkgLocalName) {
          ensureSymlink(path.join('node_modules', pkgLocalName), pkgDir)
        }
      }

      if (shouldTrackHead) {
        metadata.heads ??= {}
        metadata.heads[pkgKey] = pkgHead

        if (pkgHeadChanged) {
          saveJsonFile(metadataPath, metadata)
        } else {
          debug(`Nothing changed with ${formatRelative(pkgDir)}`)
        }
      }
    }

    for (const name of repo.inheritDependencies ?? []) {
      const targetDir = path.join(repo.dir, 'node_modules', name)
      const targetPkg = readPackageJson(targetDir)
      if (!targetPkg) {
        console.warn(
          c.yellow('⚠️  Failed to inherit %s from %s'),
          name,
          formatRelative(repo.dir)
        )
        continue
      }

      ensureSymlink(path.join('node_modules', name), targetDir)

      if (isString(targetPkg.bin)) {
        if (targetPkg.name) {
          ensureSymlink(
            path.join('node_modules/.bin', targetPkg.name),
            path.join(targetDir, targetPkg.bin)
          )
        }
      } else if (isObject(targetPkg.bin)) {
        for (const name in targetPkg.bin) {
          ensureSymlink(
            path.join('node_modules/.bin', name),
            path.join(targetDir, targetPkg.bin[name])
          )
        }
      }
    }

    for (const [from, to] of Object.entries(repo.linkFiles ?? {})) {
      ensureSymlink(from, path.join(repo.dir, to))
    }
  }

  if (metadata.heads) {
    // Drop metadata for packages no longer in the repo.
    for (const pkgKey of Object.keys(previousHeads)) {
      const pkgPath = path.join(
        path.dirname(workspaceRoot || nearestRoot),
        pkgKey
      )
      if (!existsSync(pkgPath)) {
        delete metadata.heads[pkgKey]
      }
    }
    saveJsonFile(metadataPath, metadata)
  }
}

interface Metadata {
  /** The last seen commit hash for each package. */
  heads?: Record<string, string>
}

interface PackageJson extends Record<string, unknown> {
  name?: string
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  return readJsonFile(path.join(dir, 'package.json'))
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    debug(`Error reading ${formatRelative(file)}: %s`, error)
    return null
  }
}

function saveJsonFile(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

function ensureSymlink(from: string, to: string) {
  if (debug.enabled) {
    debug(`Linking ${formatRelative(from)} to ${formatRelative(to)}`)
  }
  rmSync(from, { recursive: true, force: true })
  mkdirSync(path.dirname(from), { recursive: true })
  symlinkSync(path.relative(path.dirname(from), to), from)
}

function formatRelative(file: string) {
  file = path.posix.normalize(path.relative(process.cwd(), file))
  return file.startsWith('..') ? file : `./${file}`
}

function isCommitHash(ref: string) {
  return /^[0-9a-f]{40}$/.test(ref)
}

function hasLockfile(dir: string) {
  return existsSync(path.join(dir, 'pnpm-lock.yaml'))
}

function isWorkspace(dir: string) {
  return existsSync(path.join(dir, 'pnpm-workspace.yaml'))
}
