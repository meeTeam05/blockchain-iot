// AirSafetyLog bindings shared by the chain worker and the API startup check.
import { Contract, JsonRpcProvider, TypedDataEncoder, Wallet, getAddress } from 'ethers';

import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments.js';

export const INCIDENT_STATUS = Object.freeze({ None: 0n, Logged: 1n, Acknowledged: 2n, Resolved: 3n });

export class ChainFatalError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'ChainFatalError';
        this.cause = cause;
    }
}

export function createProvider(rpcUrl) {
    if (!rpcUrl) throw new TypeError('CHAIN_RPC_URL is required');
    return new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

// read: view calls; relayer: logIncident; manager: device lifecycle. Keys are optional so
// the API can build a read-only context for its startup check.
export function createChainContext({ provider, address, relayerPrivateKey = '', deviceManagerPrivateKey = '' }) {
    const read = new Contract(getAddress(address), AIR_SAFETY_LOG_ABI, provider);
    const relayerWallet = relayerPrivateKey ? new Wallet(relayerPrivateKey, provider) : null;
    const managerWallet = deviceManagerPrivateKey ? new Wallet(deviceManagerPrivateKey, provider) : null;
    return {
        provider,
        address: getAddress(address),
        read,
        relayerWallet,
        managerWallet,
        relayer: relayerWallet ? read.connect(relayerWallet) : null,
        manager: managerWallet ? read.connect(managerWallet) : null,
    };
}

// Readable one-line error for logs/DB. ethers can leave shortMessage or message empty
// (e.g. a refused connection), so fall through on empty strings, not only on null.
export function chainErrorText(err) {
    const text = err?.shortMessage || err?.message || err?.code
        || (err !== null && typeof err === 'object' ? err.name : String(err ?? ''));
    return String(text || 'unknown error').slice(0, 500);
}

// Decoded custom error ({ name, args }) of a reverted call, or null for transport errors.
export function decodeRevert(err, contract) {
    const seen = new Set();
    const queue = [err];
    while (queue.length) {
        const e = queue.shift();
        if (!e || typeof e !== 'object' || seen.has(e)) continue;
        seen.add(e);
        if (e.revert?.name) return { name: e.revert.name, args: [...(e.revert.args ?? [])] };
        if (typeof e.data === 'string' && /^0x[0-9a-fA-F]{8}/.test(e.data)) {
            const parsed = contract.interface.parseError(e.data);
            return parsed ? { name: parsed.name, args: [...parsed.args] } : { name: 'UnknownRevert', args: [e.data] };
        }
        queue.push(e.cause, e.error, e.info?.error, e.data);
    }
    return null;
}

// Throws when the configured EIP-712 domain is not the one the contract at that address
// uses (wrong address, wrong chain, or no contract deployed there).
export async function assertDomainMatchesChain(provider, domain) {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(domain.chainId)) {
        throw new ChainFatalError(`RPC chainId ${network.chainId} does not match incident domain chainId ${domain.chainId}`);
    }
    const code = await provider.getCode(domain.verifyingContract);
    if (!code || code === '0x') {
        throw new ChainFatalError(`no contract deployed at ${domain.verifyingContract}`);
    }
    const contract = new Contract(domain.verifyingContract, AIR_SAFETY_LOG_ABI, provider);
    const onchain = await contract.domainSeparator();
    const local = TypedDataEncoder.hashDomain({
        name: domain.name,
        version: domain.version,
        chainId: BigInt(domain.chainId),
        verifyingContract: domain.verifyingContract,
    });
    if (onchain.toLowerCase() !== local.toLowerCase()) {
        throw new ChainFatalError(`EIP-712 domain mismatch: chain=${onchain} local=${local}`);
    }
    return local;
}

export async function assertRoles(ctx) {
    const missing = [];
    if (ctx.relayerWallet) {
        const role = await ctx.read.RELAYER_ROLE();
        if (!(await ctx.read.hasRole(role, ctx.relayerWallet.address))) missing.push(`RELAYER_ROLE for ${ctx.relayerWallet.address}`);
    }
    if (ctx.managerWallet) {
        const role = await ctx.read.DEVICE_MANAGER_ROLE();
        if (!(await ctx.read.hasRole(role, ctx.managerWallet.address))) missing.push(`DEVICE_MANAGER_ROLE for ${ctx.managerWallet.address}`);
    }
    if (missing.length) throw new ChainFatalError(`missing on-chain roles: ${missing.join(', ')}`);
}
