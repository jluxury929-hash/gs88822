// ===============================================================================
// APEX MASTER ENGINE v12.6.0 (FAILOVER + PENDING NONCE + WSS HEARTBEAT)
// ===============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// 1. GLOBAL SETTINGS
const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const CONTRACT_ADDR = "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0";

const RPC_POOL = [
    { url: process.env.QUICKNODE_HTTP || "https://mainnet.base.org", priority: 1 },
    { url: "https://base.drpc.org", priority: 2 },
    { url: "https://base.llamarpc.com", priority: 3 }
];

const WSS_URLS = [process.env.QUICKNODE_WSS || "wss://base-rpc.publicnode.com"];

const TOKENS = { 
    WETH: "0x4200000000000000000000000000000000000006", 
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" 
};

const DEX_ROUTERS = { 
    AERODROME: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", 
    UNISWAP: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" 
};

const ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external"
];

let provider, signer, flashContract, transactionNonce;
let lastLogTime = Date.now();
let successfulStrikes = 0;

// 2. STABILIZED MULTI-RPC BOOT
async function initProvider() {
    try {
        const network = ethers.Network.from(8453); // Base
        const fallbackConfigs = RPC_POOL.map(cfg => ({
            provider: new ethers.JsonRpcProvider(cfg.url, network, { staticNetwork: network }),
            priority: cfg.priority,
            stallTimeout: 2500
        }));

        provider = new ethers.FallbackProvider(fallbackConfigs, network, { quorum: 1 });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);
        
        // FIX: Always use 'pending' for Nonce to prevent collisions
        transactionNonce = await provider.getTransactionCount(signer.address, 'pending');
        const bal = await provider.getBalance(signer.address);

        console.log(`\n--- ENGINE ONLINE (v12.6.0) ---`);
        console.log(`[WALLET] ETH: ${ethers.formatEther(bal)}`);
        console.log(`[NONCE] Current: ${transactionNonce}\n`);
    } catch (e) {
        console.log(`[RETRY] Boot failed: ${e.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 5000));
        return initProvider();
    }
}

// 3. AGGRESSIVE EXECUTION
async function executeStrike(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const isDex = Object.values(DEX_ROUTERS).some(r => r.toLowerCase() === tx.to.toLowerCase());
        
        if (isDex && tx.value > ethers.parseEther("0.1")) {
            // FIX: Gas Guard - prevents "Profit Detected" loop if out of gas
            const bal = await provider.getBalance(signer.address);
            if (bal < ethers.parseEther("0.001")) {
                lastLogTime = Date.now(); // Reset idle timer even if we skip
                return;
            }

            lastLogTime = Date.now();
            console.log(`[🎯 TARGET] Whale: ${ethers.formatEther(tx.value)} ETH. Simulating...`);

            try {
                // Simulation
                await flashContract.executeFlashArbitrage.staticCall(TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"));
                console.log("[🔥 PROFIT] Bidding for Priority...");

                const strikeTx = await flashContract.executeFlashArbitrage(
                    TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"), 
                    {
                        gasLimit: 850000,
                        maxPriorityFeePerGas: ethers.parseUnits('2.5', 'gwei'), // High speed tip
                        nonce: transactionNonce++
                    }
                );

                console.log(`[🚀 FLASH SENT] Hash: ${strikeTx.hash}`);
                const receipt = await strikeTx.wait();
                if (receipt.status === 1) {
                    successfulStrikes++;
                    console.log(`[💰 SUCCESS] Profit Secured!`);
                }
            } catch (simErr) { /* Non-profitable trade */ }
        }
    } catch (e) {
        if (e.message.includes("nonce")) {
            transactionNonce = await provider.getTransactionCount(signer.address, 'pending');
        }
    }
}

// 4. SCANNER & HEARTBEAT
function startScanning() {
    console.log(`🔍 SCANNING MEMPOOL: ${WSS_URLS[0].substring(0, 20)}...`);
    const wssProvider = new ethers.WebSocketProvider(WSS_URLS[0]);

    wssProvider.on("pending", (h) => executeStrike(h));

    // WebSocket Heartbeat
    const heartbeat = setInterval(() => {
        if (wssProvider.websocket.readyState === 1) wssProvider.websocket.ping();
    }, 30000);

    wssProvider.websocket.on("close", () => {
        clearInterval(heartbeat);
        console.log("🔄 WSS Reset. Reconnecting...");
        setTimeout(startScanning, 5000);
    });

    setInterval(() => {
        const idle = (Date.now() - lastLogTime) / 1000;
        console.log(`[SCAN] Active. Idle: ${idle.toFixed(0)}s | Wins: ${successfulStrikes}`);
        
        // Safety Restart - increased to 10 mins to account for slow network periods
        if (idle > 600) {
            console.log("[RESTART] No activity detected. Resyncing...");
            process.exit(1);
        }
    }, 60000);
}

// 5. STATUS API
app.get('/status', async (req, res) => {
    try {
        const walletBal = await provider.getBalance(signer.address);
        const contractBal = await flashContract.getContractBalance();
        res.json({
            status: "HUNTING",
            wallet_eth: ethers.formatEther(walletBal),
            contract_weth: ethers.formatEther(contractBal),
            wins: successfulStrikes
        });
    } catch (e) { res.json({ status: "ERROR" }); }
});

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SYSTEM] Master Engine v12.6.0 Live on Port ${PORT}`);
        startScanning();
    });
});
