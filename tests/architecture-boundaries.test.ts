import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function TypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return await TypeScriptFiles(target);
      return entry.name.endsWith(".ts") ? [target] : [];
    }),
  );
  return nested.flat();
}

describe("package dependency boundaries", () => {
  it("keeps runtime independent of concrete providers and tools", async () => {
    const files = await TypeScriptFiles(path.join(root, "packages", "runtime", "src"));
    const contents = await Promise.all(files.map(async (file) => await readFile(file, "utf8")));
    expect(contents.join("\n")).not.toMatch(/@agent-org\/(providers|tools)|from ["']openai["']/u);

    const manifest = JSON.parse(
      await readFile(path.join(root, "packages", "runtime", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies).not.toHaveProperty("@agent-org/providers");
    expect(manifest.dependencies).not.toHaveProperty("@agent-org/tools");
    expect(manifest.dependencies).not.toHaveProperty("openai");
  });

  it("confines the OpenAI SDK dependency to the providers package", async () => {
    const packages = ["core", "providers", "tools", "runtime", "cli"];
    for (const packageName of packages) {
      const manifest = JSON.parse(
        await readFile(path.join(root, "packages", packageName, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(Boolean(manifest.dependencies?.openai)).toBe(packageName === "providers");
    }
  });
});
