import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import ts from 'typescript';

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

// bin/plugin.js is an ES module. Node before 20.19 / 22.7 does not detect that from the syntax and needs a
// package.json that says so next to it; Fifine Control Deck runs plugins on Node 20.8.1 (docs/compatibility.md).
// In the repository the package's own package.json says it, but an installed plugin has nothing above it.
const moduleType = {
  name: 'module-type',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'package.json',
      source: JSON.stringify({ type: 'module' }) + '\n',
    });
  },
};

export default {
  context: 'globalThis',
  input: 'src/plugin.ts',
  output: { file: 'pl.1am.orca-agent-deck.sdPlugin/bin/plugin.js', format: 'es', sourcemap: true },
  plugins: [
    moduleType,
    transpile,
    commonjs(),
    nodeResolve({
      extensions: ['.ts', '.mjs', '.js'],
      browser: false,
      exportConditions: ['node'],
      preferBuiltins: true,
    }),
  ],
};
