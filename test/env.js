// Loaded before every test file (package.json "test"). The suites register many new addresses
// with their own small clients, so registration work (shared/pow.js) is off unless a test
// turns it on itself; test/pow.test.js does.
process.env.FABRIC_REGISTER_POW_BITS ??= '0';
