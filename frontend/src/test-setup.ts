import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount and remove every rendered tree between tests. Without this a
// finished test's DOM stays in `document.body`, so `screen` queries in the
// next test can match text belonging to the previous one - which makes the
// suite order-dependent and lets a passing assertion mean nothing.
afterEach(() => {
  cleanup();
});
