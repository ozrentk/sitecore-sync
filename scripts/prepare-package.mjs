import { mkdir, rm } from "node:fs/promises";

const distributionDirectory = new URL("../dist/", import.meta.url);

await mkdir(distributionDirectory, { recursive: true });
await rm(new URL("sitecore-xm-cloud-sync.vsix", distributionDirectory), { force: true });
