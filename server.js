// ===============================================================================
// MASTER ENGINE v12.3.0 (STABILIZED FLASH LOAN + MULTI-RPC FALLBACK)
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
const PAYOUT_WALLET = process.env.PAYOUT_WALLET || "0xSET_YOUR_WALLET";

// RPC CONFIGURATION (Prioritizes your Quicknode if provided)
const RPC_POOL = [
    { url: process.env.QUICKNODE_HTTP || "https://mainnet.base.org", priority: 1 },
    { url: "https://base.drpc.org", priority: 2 },
    { url: "https://base.llamarpc.com", priority: 3 },
    { url: "https://base-rpc.publicnode.com", priority: 4 }
];

const WSS_URLS = [process.env.QUICKNODE_WSS || "wss://base-rpc.publicnode.com", "wss://base.drpc.org"];

const TOKENS = { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const DEX_ROUTERS = { AERODROME: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", UNISWAP: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" };

const CONTRACT_ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external"
];

let provider, signer, flashContract, transactionNonce;
let lastLogTime = Date.now();
let successfulStrikes = 0;

// ===============================================================================
// 2. STABILIZED MULTI-RPC INITIALIZATION
// ===============================================================================

async function initProvider() {
    try {
        const network = ethers.Network.from(8453); // Base Mainnet

        // Create fallback configs: quorum is 1 so the engine stays alive if ANY node works
        const fallbackConfigs = RPC_POOL.map(cfg => ({
            provider: new ethers.JsonRpcProvider(cfg.url, network, { staticNetwork: network }),
            priority: cfg.priority,
            weight: 1,
            stallTimeout: 2500 // 2.5s timeout per node
        }));

        provider = new ethers.FallbackProvider(fallbackConfigs, network, { quorum: 1 });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, signer);
        
        // Warm up and verify connection
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        const bal = await provider.getBalance(signer.address);

        console.log(`\n--- ENGINE STARTING (STABILIZED) ---`);
        console.log(`[WALLET] ETH: ${ethers.formatEther(bal)}`);
        console.log(`[NODE] Active: Multi-RPC Pool Monitor`);
        console.log(`[NONCE] Current: ${transactionNonce}\n`);
    } catch (e) {
        console.log(`[RETRY] Connection failed: ${e.message}. Restarting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        return initProvider();
    }
}

// ===============================================================================
// 3. AGGRESSIVE EXECUTION
// ===============================================================================

async function executeStrike(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const isDex = Object.values(DEX_ROUTERS).some(r => r.toLowerCase() === tx.to.toLowerCase());
        
        if (isDex && tx.value > ethers.parseEther("0.2")) {
            lastLogTime = Date.now();
            console.log(`[🎯 TARGET] Whale: ${ethers.formatEther(tx.value)} ETH. Running Simulation...`);

            try {
                // 1. Simulate the trade (On-chain check)
                await flashContract.executeFlashArbitrage.staticCall(TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"));
                
                console.log("[🔥 PROFIT DETECTED] Bidding for Block Priority...");

                // 2. High-Priority Execution
                const strikeTx = await flashContract.executeFlashArbitrage(
                    TOKENS.WETH, 
                    TOKENS.USDC, 
                    ethers.parseEther("100"), 
                    {
                        gasLimit: 750000,
                        maxPriorityFeePerGas: ethers.parseUnits('1.5', 'gwei'), 
                        nonce: transactionNonce++
                    }
                );

                console.log(`[🚀 FLASH SENT] Hash: ${strikeTx.hash}`);
                
                const receipt = await strikeTx.wait();
                if (receipt.status === 1) {
                    successfulStrikes++;
                    const newBal = await flashContract.getContractBalance();
                    console.log(`[💰 SUCCESS] Profit Secured! Contract WETH: ${ethers.formatEther(newBal)}`);
                }
            } catch (simErr) {
                // If staticCall fails, the trade wasn't profitable or the contract reverted
            }
        }
    } catch (e) {
        // Fallback provider handles internal RPC failures; we only log major errors
        if (e.message.includes("insufficient funds")) console.log("[⚠️] Gas required to execute.");
    }
}

// ===============================================================================
// 4. MONITORING & STATUS
// ===============================================================================

app.get('/status', async (req, res) => {
    try {
        const walletBal = await provider.getBalance(signer.address);
        const contractBal = await flashContract.getContractBalance();
        res.json({
            status: "HUNTING",
            wallet_eth: ethers.formatEther(walletBal),
            contract_earnings_weth: ethers.formatEther(contractBal),
            total_wins: successfulStrikes,
            strategy: "100 ETH Flash Loan",
            gas_mode: "Aggressive (1.5 Gwei Tip)"
        });
    } catch (e) { res.json({ status: "RECONNECTING" }); }
});

function startScanning() {
    // pending transactions usually require WebSocket
    const wssUrl = WSS_URLS[0]; 
    const wssProvider = new ethers.WebSocketProvider(wssUrl);

    wssProvider.on("pending", (h) => executeStrike(h));

    setInterval(() => {
        const idle = (Date.now() - lastLogTime) / 1000;
        console.log(`[SCAN] Active. Idle: ${idle.toFixed(0)}s | Wins: ${successfulStrikes}`);
        if (idle > 300) { 
            console.log("[RESTART] Idle too long. Re-syncing...");
            process.exit(1); 
        }
    }, 60000);
}

// 5. BOOT
initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SYSTEM] Master Engine v12.3.0 Live on Port ${PORT}`);
        startScanning();
    });
});
