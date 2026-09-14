const fs = require('node:fs')
const path = require('node:path')

function contains(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

// Resolve existing ancestors too, so a junction cannot redirect a future output path.
function canonical(candidate) {
  const resolved = path.resolve(candidate)
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved)
  const parent = path.dirname(resolved)
  if (parent === resolved) return resolved
  return path.join(canonical(parent), path.basename(resolved))
}

function withinRoots(candidate, roots) {
  try {
    const resolved = canonical(candidate)
    return roots.some(root => contains(canonical(root), resolved))
  } catch { return false }
}

function ownedOutput(requested, base) {
  // The output root itself must not be redirected outside its installation.
  if (!contains(canonical(path.dirname(base)), canonical(base))) return null
  const destination = path.resolve(requested)
  return withinRoots(destination, [base]) ? destination : null
}

module.exports = { contains, canonical, withinRoots, ownedOutput }
