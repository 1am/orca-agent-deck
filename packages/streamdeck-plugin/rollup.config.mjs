import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import { fileURLToPath, URL } from 'node:url';
import ts from 'typescript';

// Workspace packages are consumed as TypeScript source.
const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = {
  name: 'workspace',
  resolveId(id) {
    if (id === '@orca-agent-deck/core') return `${root}core/src/index.ts`;
    if (id === '@orca-agent-deck/adapter-cli') return `${root}adapter-cli/src/index.ts`;
    if (id === '@orca-agent-deck/adapter-runtime') return `${root}adapter-runtime/src/index.ts`;
    if (id === '@orca-agent-deck/adapter-bridge') return `${root}adapter-bridge/src/index.ts`;
    if (id === '@orca-agent-deck/window-raiser') return `${root}window-raiser/src/index.ts`;
    return null;
  },
};

// Transpile only; type checking is `tsc --noEmit` in the build script.
const transpile = {
  name: 'transpile',
  transform(code, id) {
    if (!id.endsWith('.ts')) return null;
    const out = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
      },
    });
    return {
      code: out.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ''),
      map: null,
    };
  },
};

export default {
  context: 'globalThis',
  input: 'src/plugin.ts',
  output: { file: 'pl.1am.orca-agent-deck.sdPlugin/bin/plugin.js', format: 'es', sourcemap: true },
  plugins: [
    workspace,
    transpile,
    commonjs(),
    nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
  ],
};
