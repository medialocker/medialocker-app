/**
 * Per-worker setup file (vitest `setupFiles`): runs in every test worker BEFORE
 * any test module — and therefore before @medialocker/config is first imported
 * and caches its values. It mirrors the throwaway-stack connection settings into
 * process.env so the production client constructors target the test stack.
 *
 * (globalSetup runs once in the main process to migrate the DB; setupFiles runs
 * once per worker to fix up that worker's env — both are needed because workers
 * are separate processes.)
 */
import { applyTestEnv } from "./test-env.js";

applyTestEnv();
