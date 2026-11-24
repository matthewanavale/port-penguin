// D15b: one time zone on Windows, macOS, and Linux. This runs before any
// test file is imported, so before any date is made.
process.env.TZ = "UTC";
