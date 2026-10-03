import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export async function importEdgeFunction(url, exportsList = []) {
  const path = fileURLToPath(url)
  const source = await readFile(path, 'utf8')
  const compiled = await build({
    stdin: { contents: `${source}\n${exportsList.length ? `export { ${exportsList.join(', ')} }` : ''}`, resolveDir: dirname(path), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false,
    plugins: [{ name: 'authenticated-handler-fixture', setup(builder) {
      builder.onResolve({ filter: /^npm:@supabase\/server@/ }, () => ({ path: 'server', namespace: 'test-auth' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-auth' }, () => ({ contents: 'export const withSupabase = (_options, handler) => handler' }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
}
