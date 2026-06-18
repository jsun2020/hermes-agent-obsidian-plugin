import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["main.js", "tests/.build/**", "node_modules/**", "esbuild.config.mjs", "eslint.config.mjs"]
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The official Obsidian reviewer does not gate on this rule, and "Hermes"
      // is a product name that must not be lower-cased. Disabled to mirror the
      // reviewer's actual ruleset.
      "obsidianmd/ui/sentence-case": "off"
    }
  }
);
