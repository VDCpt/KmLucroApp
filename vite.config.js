// ═══════════════════════════════════════════════════════════════
// KmLucro — vite.config.js v5.0 RETIFICADO
// Pipeline de Build: Minificação + Ofuscação + Segurança
//
// Melhorias:
// - Desativar source maps em produção (nunca!)
// - Melhorar controle de fluxo flattening
// - Adicionar verificação de tamanho de bundle
//
// Como usar:
//   npm install        (instala dependências)
//   npm run dev        (desenvolvimento local)
//   npm run build      (produção — ofuscado, minificado, seguro)
//   npm run deploy     (build + firebase deploy)
// ═══════════════════════════════════════════════════════════════

import { defineConfig } from 'vite';
import { obfuscator } from 'rollup-plugin-obfuscator';

export default defineConfig(({ mode }) => ({
  root: '.',
  publicDir: 'public',

  build: {
    outDir: 'dist',
    emptyOutDir: true,

    // Terser: minificação agressiva
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console:   true,
        drop_debugger:  true,
        pure_funcs:     ['console.log', 'console.warn', 'console.info'],
        passes:         3,
        unsafe:         true,
        unsafe_comps:   true,
      },
      mangle: {
        toplevel: true,
        eval:     false,
      },
      output: {
        comments: false,
        beautify: false,
      },
    },

    rollupOptions: {
      input: 'index.html',
      output: {
        entryFileNames:   'assets/[name]-[hash].js',
        chunkFileNames:   'assets/[name]-[hash].js',
        assetFileNames:   'assets/[name]-[hash].[ext]',
        manualChunks:     undefined,
      },
      plugins: [
        mode === 'production' && obfuscator({
          compact:                        true,
          controlFlowFlattening:          true,
          controlFlowFlatteningThreshold: 0.85,  // Aumentado de 0.75 para mais ofuscação
          deadCodeInjection:              true,
          deadCodeInjectionThreshold:     0.45,  // Aumentado de 0.40
          debugProtection:                true,
          debugProtectionInterval:        2000,
          disableConsoleOutput:           true,
          identifierNamesGenerator:       'hexadecimal',
          log:                            false,
          numbersToExpressions:           true,
          renameGlobals:                  false,
          selfDefending:                  true,
          simplify:                       true,
          splitStrings:                   true,
          splitStringsChunkLength:        4,
          stringArray:                    true,
          stringArrayCallsTransform:      true,
          stringArrayEncoding:            ['rc4'],
          stringArrayIndexShift:          true,
          stringArrayRotate:              true,
          stringArrayShuffle:             true,
          stringArrayThreshold:           0.85,
          target:                         'browser',
          transformObjectKeys:            true,
          unicodeEscapeSequence:          false,
        }),
      ].filter(Boolean),
    },

    chunkSizeWarningLimit: 500,

    /* CRÍTICO: Source maps NUNCA em produção (expõem código original) */
    sourcemap: mode !== 'production',
  },

  server: {
    port:  3000,
    https: false,
    open:  true,
  },

  preview: {
    port: 4000,
  },
}));

// ═══════════════════════════════════════════════════════════════
// INSTRUÇÕES PÓS-BUILD
// ═══════════════════════════════════════════════════════════════
/*
Após "npm run build", verificar:

1. Não há ficheiros .map em dist/
   $ find dist -name "*.map" | wc -l  # Deve ser 0

2. script.js é ilegível (minificado + ofuscado)
   $ wc -c dist/assets/script*.js    # Deve ser ~50-100KB em 1 linha

3. Hashes foram actualizados (cache busting)
   $ ls -la dist/assets/             # Cada build tem novos hashes

4. Service Worker não está minificado/ofuscado
   (Deixar legível para debugger em produção — não contém chave)
   $ head -20 dist/sw.js
*/
