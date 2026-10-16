import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = process.cwd();
const temporaryRoot = await mkdtemp(join(projectRoot, "node_modules/.server-esm-load-"));
const productionServerSources = [
  "src/chain/errors.ts",
  "src/chain/confirmationPolicy.ts",
  "src/chain/hashCodec.ts",
  "src/deliveryProof.ts",
  "src/tokenReportPolicy.ts",
  "src/server/chainRpc.ts",
  "src/server/vercelProxy.ts",
  "src/server/serverEnv.ts",
  "src/server/requestRateLimit.ts",
  "src/server/sharedRoleResolver.ts",
  "src/server/tokenCompatibility.ts",
  "src/server/bountiesApiHandler.ts",
  "src/server/walletAuthHandler.ts",
  "src/server/sharedSignIn.ts",
  "api/sso/[action].ts"
];

try {
  for(const file of ['lib/ecosystem-client.mjs','shared/ecosystem-authority.mjs','shared/signed-action.mjs','shared/sso/client.mjs','shared/sso/profile-model.mjs']){
    const dest=join(temporaryRoot,file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,await readFile(join(projectRoot,file),'utf8'));
  }
  for (const sourcePath of productionServerSources) {
    const source = await readFile(join(projectRoot, sourcePath), "utf8");
    const emittedPath = join(temporaryRoot, sourcePath.replace(/\.ts$/, ".js"));
    const emitted = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    });
    await mkdir(dirname(emittedPath), { recursive: true });
    await writeFile(emittedPath, emitted.outputText);
  }

  for (const handler of ["src/server/bountiesApiHandler.js", "src/server/walletAuthHandler.js", "api/sso/[action].js"]) {
    const handlerPath = join(temporaryRoot, handler);
    await import(pathToFileURL(handlerPath).href);
    process.stdout.write(`Loaded ${relative(projectRoot, handlerPath)} with Node ESM.\n`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
