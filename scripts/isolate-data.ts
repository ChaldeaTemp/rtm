// Imported first by every verify and benchmark script: points the hub's install-level data
// (tasks, settings, uploads, runtime info) at a throwaway directory, so a test run can never
// read or change the data of the real installation. Child processes inherit the setting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.RTM_DATA_DIR) {
  process.env.RTM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-test-data-"));
}
