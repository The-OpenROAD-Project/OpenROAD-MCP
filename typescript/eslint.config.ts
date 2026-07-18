import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import type { ESLint, Linter } from "eslint";

const config: Linter.Config[] = [
  {
    ignores: ["coverage/**"],
  },
  {
    files: ["src/**/*.ts", "__tests__/**/*.ts"],
    languageOptions: {
      parser: tsParser as Linter.Parser,
    },
    plugins: { "@typescript-eslint": tseslint as unknown as ESLint.Plugin },
    rules: {
      ...(tseslint.configs?.["recommended"]?.rules ?? {}),
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
];

export default config;
