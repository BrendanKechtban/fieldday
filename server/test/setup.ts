import { afterAll } from "vitest";
import { closeTestDbs } from "./helpers.js";

afterAll(async () => { await closeTestDbs(); });
