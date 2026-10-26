/**
 * REAL drand beacons, fetched 2026-10-25 and stored so that unit tests verify
 * signatures offline. Each is exactly what the relay returned.
 *
 * quicknet: https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
 *   (api2.drand.sh and drand.cloudflare.com returned identical values for 1000000)
 * default (chained mainnet, a DIFFERENT chain):
 *   https://api.drand.sh/8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce/public/1000000
 */
export const QUICKNET_1000000 = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
} as const;

export const QUICKNET_12345678 = {
  round: 12345678,
  randomness: '47175ae9652cb6704c2b509e5d2aa03b609e67039251ff1e162282136c515bf0',
  signature: 'b0a199d51b7c29117d2155c4fc2322dbacd9d1e1f11da5b5c0e4e19947e4aaf634970e85eceef450681d27baa3a03f20',
} as const;

export const DEFAULT_CHAIN_1000000 = {
  round: 1000000,
  randomness: 'a26ba4d229c666f52a06f1a9be1278dcc7a80dbc1dd2004a1ae7b63cb79fd37e',
  signature:
    '87e355169c4410a8ad6d3e7f5094b2122932c1062f603e6628aba2e4cb54f46c3bf1083c3537cd3b99e8296784f46fb40e090961cf9634f02c7dc2a96b69fc3c03735bc419962780a71245b72f81882cf6bb9c961bcf32da5624993bb747c9e5',
  previous_signature:
    '86bbc40c9d9347568967add4ddf6e351aff604352a7e1eec9b20dea4ca531ed6c7d38de9956ffc3bb5a7fabe28b3a36b069c8113bd9824135c3bff9b03359476f6b03beec179d4aeff456f4d34bbf702b9af78c3bb44e1892ace8e581bf4afa9',
} as const;
