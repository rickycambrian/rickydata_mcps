/** Known chain configurations for ERC-8004 agent registry lookups. */
export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
}

/** dRPC chain slug map — chainId → dRPC slug for URL construction */
const DRPC_CHAIN_SLUGS: Record<number, string> = {
  // Mainnets
  1: 'ethereum',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  56: 'bsc',
  43114: 'avalanche',
  250: 'fantom',
  100: 'gnosis',
  324: 'zksync',
  1101: 'polygon-zkevm',
  59144: 'linea',
  534352: 'scroll',
  5000: 'mantle',
  169: 'manta-pacific',
  81457: 'blast',
  7777777: 'zora',
  34443: 'mode',
  252: 'fraxtal',
  1284: 'moonbeam',
  1285: 'moonriver',
  42220: 'celo',
  1088: 'metis',
  288: 'boba',
  25: 'cronos',
  2222: 'kava',
  1666600000: 'harmony',
  106: 'velas',
  1313161554: 'aurora',
  122: 'fuse',
  40: 'telos',
  592: 'astar',
  204: 'opbnb',
  8217: 'klaytn',
  // Testnets
  11155111: 'sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
  11155420: 'optimism-sepolia',
  80002: 'polygon-amoy',
};

export const CHAINS: Record<number, ChainConfig> = {
  // ── Mainnets ──
  1: {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpcUrl: "https://eth.llamarpc.com",
    explorerUrl: "https://etherscan.io",
  },
  137: {
    chainId: 137,
    name: "Polygon",
    rpcUrl: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
  },
  10: {
    chainId: 10,
    name: "Optimism",
    rpcUrl: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
  },
  56: {
    chainId: 56,
    name: "BNB Smart Chain",
    rpcUrl: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
  },
  43114: {
    chainId: 43114,
    name: "Avalanche C-Chain",
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
  },
  250: {
    chainId: 250,
    name: "Fantom",
    rpcUrl: "https://rpc.ftm.tools",
    explorerUrl: "https://ftmscan.com",
  },
  100: {
    chainId: 100,
    name: "Gnosis",
    rpcUrl: "https://rpc.gnosischain.com",
    explorerUrl: "https://gnosisscan.io",
  },
  324: {
    chainId: 324,
    name: "zkSync Era",
    rpcUrl: "https://mainnet.era.zksync.io",
    explorerUrl: "https://explorer.zksync.io",
  },
  1101: {
    chainId: 1101,
    name: "Polygon zkEVM",
    rpcUrl: "https://zkevm-rpc.com",
    explorerUrl: "https://zkevm.polygonscan.com",
  },
  59144: {
    chainId: 59144,
    name: "Linea",
    rpcUrl: "https://rpc.linea.build",
    explorerUrl: "https://lineascan.build",
  },
  534352: {
    chainId: 534352,
    name: "Scroll",
    rpcUrl: "https://rpc.scroll.io",
    explorerUrl: "https://scrollscan.com",
  },
  5000: {
    chainId: 5000,
    name: "Mantle",
    rpcUrl: "https://rpc.mantle.xyz",
    explorerUrl: "https://explorer.mantle.xyz",
  },
  169: {
    chainId: 169,
    name: "Manta Pacific",
    rpcUrl: "https://pacific-rpc.manta.network/http",
    explorerUrl: "https://pacific-explorer.manta.network",
  },
  81457: {
    chainId: 81457,
    name: "Blast",
    rpcUrl: "https://rpc.blast.io",
    explorerUrl: "https://blastscan.io",
  },
  7777777: {
    chainId: 7777777,
    name: "Zora",
    rpcUrl: "https://rpc.zora.energy",
    explorerUrl: "https://explorer.zora.energy",
  },
  34443: {
    chainId: 34443,
    name: "Mode",
    rpcUrl: "https://mainnet.mode.network",
    explorerUrl: "https://explorer.mode.network",
  },
  252: {
    chainId: 252,
    name: "Fraxtal",
    rpcUrl: "https://rpc.frax.com",
    explorerUrl: "https://fraxscan.com",
  },
  1284: {
    chainId: 1284,
    name: "Moonbeam",
    rpcUrl: "https://rpc.api.moonbeam.network",
    explorerUrl: "https://moonbeam.moonscan.io",
  },
  1285: {
    chainId: 1285,
    name: "Moonriver",
    rpcUrl: "https://rpc.api.moonriver.moonbeam.network",
    explorerUrl: "https://moonriver.moonscan.io",
  },
  42220: {
    chainId: 42220,
    name: "Celo",
    rpcUrl: "https://forno.celo.org",
    explorerUrl: "https://celoscan.io",
  },
  1088: {
    chainId: 1088,
    name: "Metis",
    rpcUrl: "https://andromeda.metis.io/?owner=1088",
    explorerUrl: "https://andromeda-explorer.metis.io",
  },
  288: {
    chainId: 288,
    name: "Boba Network",
    rpcUrl: "https://mainnet.boba.network",
    explorerUrl: "https://bobascan.com",
  },
  25: {
    chainId: 25,
    name: "Cronos",
    rpcUrl: "https://evm.cronos.org",
    explorerUrl: "https://cronoscan.com",
  },
  2222: {
    chainId: 2222,
    name: "Kava",
    rpcUrl: "https://evm.kava.io",
    explorerUrl: "https://kavascan.com",
  },
  1666600000: {
    chainId: 1666600000,
    name: "Harmony",
    rpcUrl: "https://api.harmony.one",
    explorerUrl: "https://explorer.harmony.one",
  },
  106: {
    chainId: 106,
    name: "Velas",
    rpcUrl: "https://evmexplorer.velas.com/rpc",
    explorerUrl: "https://evmexplorer.velas.com",
  },
  1313161554: {
    chainId: 1313161554,
    name: "Aurora",
    rpcUrl: "https://mainnet.aurora.dev",
    explorerUrl: "https://explorer.aurora.dev",
  },
  122: {
    chainId: 122,
    name: "Fuse",
    rpcUrl: "https://rpc.fuse.io",
    explorerUrl: "https://explorer.fuse.io",
  },
  40: {
    chainId: 40,
    name: "Telos",
    rpcUrl: "https://mainnet.telos.net/evm",
    explorerUrl: "https://teloscan.io",
  },
  592: {
    chainId: 592,
    name: "Astar",
    rpcUrl: "https://evm.astar.network",
    explorerUrl: "https://astar.subscan.io",
  },
  204: {
    chainId: 204,
    name: "opBNB",
    rpcUrl: "https://opbnb-mainnet-rpc.bnbchain.org",
    explorerUrl: "https://opbnbscan.com",
  },
  8217: {
    chainId: 8217,
    name: "Klaytn",
    rpcUrl: "https://public-en-cypress.klaytn.net",
    explorerUrl: "https://klaytnscope.com",
  },
  // ── Testnets ──
  11155111: {
    chainId: 11155111,
    name: "Sepolia",
    rpcUrl: "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
  },
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
  },
  421614: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
  },
  11155420: {
    chainId: 11155420,
    name: "Optimism Sepolia",
    rpcUrl: "https://sepolia.optimism.io",
    explorerUrl: "https://sepolia-optimistic.etherscan.io",
  },
  80002: {
    chainId: 80002,
    name: "Polygon Amoy",
    rpcUrl: "https://rpc-amoy.polygon.technology",
    explorerUrl: "https://amoy.polygonscan.com",
  },
};

/** Build a dRPC URL for the given chain */
export function getDrpcUrl(chainId: number): string | undefined {
  const slug = DRPC_CHAIN_SLUGS[chainId];
  const apiKey = process.env.DRPC_API_KEY;
  if (!slug || !apiKey) return undefined;
  return `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${apiKey}`;
}

/** Build overrideRpcUrls map for ALL known dRPC chains */
export function buildDrpcOverrides(): Record<number, string> {
  const apiKey = process.env.DRPC_API_KEY;
  if (!apiKey) return {};
  const overrides: Record<number, string> = {};
  for (const [id, slug] of Object.entries(DRPC_CHAIN_SLUGS)) {
    overrides[Number(id)] = `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${apiKey}`;
  }
  return overrides;
}

export function getChain(chainId: number): ChainConfig | undefined {
  return CHAINS[chainId];
}

export function getChainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `Chain ${chainId}`;
}
