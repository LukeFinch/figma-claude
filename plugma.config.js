export default {
  manifest: "./manifest.json",
  main: {
    input: "./src/main.tsx",
    output: "./dist/main.js",
  },
  ui: {
    input: "./src/ui.tsx",
    output: "./dist/ui.html",
    template: "./src/ui.html",
  },
  build: {
    typescript: true,
    react: true,
  },
};
