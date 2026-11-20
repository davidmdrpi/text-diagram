/** Tailwind config used by build.js to compile the CSS inlined into text-diagram.html.
 *  Keep in sync with the inline tailwind.config in index.html (used with the CDN in development). */
module.exports = {
  content: ['./index.html', './src/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // local fonts only (nothing is downloaded): Inter / JetBrains Mono if installed
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
    },
  },
};
