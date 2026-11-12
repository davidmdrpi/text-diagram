/** Tailwind config used by build.js to compile the CSS inlined into text-diagram.html.
 *  Keep in sync with the inline tailwind.config in index.html (used with the CDN in development). */
module.exports = {
  content: ['./index.html', './src/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
};
