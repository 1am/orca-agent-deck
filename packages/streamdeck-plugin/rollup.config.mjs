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

export default {
  context: 'globalThis',
  input: 'src/plugin.ts',
  output: { file: 'pl.1am.orca-agent-deck.sdPlugin/bin/plugin.js', format: 'es', sourcemap: true },
  plugins: [
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
