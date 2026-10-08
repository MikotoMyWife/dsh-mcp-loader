/**
 * Packaging assertion: every path declared in `package.json` `files` must exist
 * in a clean checkout.
 *
 * `files` decides what `npm pack` / `npm publish` ship, but it cannot create
 * content. Under this repository's allowlist `.gitignore`, a directory can be
 * listed in `files` while git tracks none of it: it then exists on the author's
 * disk alone, and a fresh clone — or any tarball built from one — silently
 * ships without it. That is not hypothetical. `locale` was declared in `files`
 * and left untracked, so the published package lost its plugin display metadata
 * while this machine kept working only because the profile install is a symlink
 * into the working tree.
 *
 * Ground truth is `git ls-tree -r HEAD`: exactly the file list a clean checkout
 * of the current commit contains. Checking HEAD rather than the index also
 * catches a path that is staged but not yet committed, which a clean checkout
 * of the pushed commit would still lack.
 *
 * Deliberately not asserted here: untracked files sitting *inside* a declared
 * directory. This repository keeps local probes such as `lib/x.js` on purpose,
 * and those are a publishing-tree concern, not a clean-checkout one.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Repo-relative POSIX paths tracked at HEAD — the contents of a clean checkout. */
function cleanCheckoutPaths() {
  let listing
  try {
    listing = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
    })
  } catch (error) {
    throw new Error(`cannot list HEAD; run this suite from a git checkout: ${error.message}`)
  }
  return listing.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Compile one `files` entry into a matcher over repo-relative POSIX paths.
 *
 * Covers the three shapes npm accepts: an exact file, a directory (which also
 * matches everything beneath it), and a glob where `*` spans any run of
 * characters within one path segment and `?` spans exactly one. An entry using
 * syntax this matcher does not understand simply matches nothing and is then
 * reported by name, rather than passing unnoticed.
 */
function matcherFor(entry) {
  const escaped = entry.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  const pattern = new RegExp(`^${source}(/.*)?$`)
  return (candidate) => pattern.test(candidate)
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const declared = manifest.files
assert.ok(
  Array.isArray(declared) && declared.length > 0,
  'package.json "files" must be a non-empty array, or nothing would ship',
)

const tracked = cleanCheckoutPaths()
const missing = []
for (const entry of declared) {
  assert.equal(typeof entry, 'string', `"files" entries must be strings, got ${JSON.stringify(entry)}`)
  assert.ok(entry.length > 0, '"files" must not contain an empty entry')
  const matches = tracked.filter(matcherFor(entry))
  if (matches.length === 0) missing.push(entry)
  console.log(`${matches.length === 0 ? 'FAIL' : 'PASS'}  packaging  "${entry}" -> ${matches.length} tracked path(s)`)
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length}/${declared.length} "files" entr${missing.length === 1 ? 'y' : 'ies'} exist on disk but not in a clean checkout:`
    + `\n  ${missing.join('\n  ')}`
    + '\nA clean clone and any tarball built from it would ship without them.'
    + '\nTrack them (see .gitignore) or drop them from "files".',
  )
  process.exit(1)
}

console.log(`\n${declared.length}/${declared.length} "files" entries exist in a clean checkout`)
