#!/usr/bin/env node
const { localOnlyInstall } = require('../src/optional-runtime')

try {
  if (process.argv.slice(2).some(arg => arg !== '--local-only')) throw new Error('只支持 --local-only；该命令不会联网安装依赖')
  console.log(JSON.stringify(localOnlyInstall(), null, 2))
} catch (error) {
  console.error(`[眼] ${error.message}`)
  process.exitCode = 1
}
