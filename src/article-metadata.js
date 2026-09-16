const cheerio = require('cheerio')
const { parse } = require('acorn')

// Static parsing only. Never evaluate script bodies or accept property assignments.
function scriptMetadata(html) {
 const $ = cheerio.load(html), values = { ct: new Set(), biz: new Set() }
 $('script:not([src])').each((_, el) => {
  const source = $(el).text()
  if (Buffer.byteLength(source) > 512 * 1024) return
  let program
  try { program = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { return }
  function accept(name, value) {
   if (!Object.hasOwn(values, name) || value?.type !== 'Literal') return
   if (!['string', 'number'].includes(typeof value.value)) return
   const text = String(value.value)
   if (name === 'ct' && !/^\d{10}$/.test(text)) return
   const n = Number(text)
   if (name === 'ct' && (n < 1325347200 || n > 2147483647)) return
   if (name === 'biz' && !/^[A-Za-z0-9+/]{6,}={0,2}$/.test(text)) return
   values[name].add(text)
  }
  for (const node of program.body) {
   if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) if (declaration.id.type === 'Identifier') accept(declaration.id.name, declaration.init)
   } else if (node.type === 'ExpressionStatement') {
    const expression = node.expression
    if (expression.type === 'AssignmentExpression' && expression.operator === '=' && expression.left.type === 'Identifier') accept(expression.left.name, expression.right)
   }
  }
 })
 // Conflicting declarations are unknown, not whichever happened to be first.
 return Object.fromEntries(Object.entries(values).map(([key, set]) => [key, set.size === 1 ? [...set][0] : '']))
}
function publicationTime(value) {
 if (typeof value !== 'string' || !value.trim()) return null
 value = value.trim()
 if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString()
 let match = value.match(/^(\d{4})[年-](\d{1,2})[月-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
 let zone = '+08:00', fraction = ''
 if (!match) {
  match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/)
  if (!match) return null
  fraction = match[7] || ''; zone = match[8]
 }
 const [, year, month, day, hour, minute, second = '0'] = match
 const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number)
 const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
 const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
 if (mo < 1 || mo > 12 || d < 1 || d > lengths[mo - 1] || h > 23 || mi > 59 || s > 59) return null
 if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null
 const stamp = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:${second.padStart(2,'0')}${fraction}${zone}`
 const timestamp = Date.parse(stamp)
 return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}
module.exports = { scriptMetadata, publicationTime }
