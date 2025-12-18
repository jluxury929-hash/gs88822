// ===============================================================================
// MASTER ENGINE v12.2.0 (BASE NETWORK - FLASH LOAN + 12 STRATS + DUAL FAILOVER)
// ===============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ===============================================================================
// 1. CONFIGURATION & CONTRACT SETUP
// ===============================================================================

const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const CONTRACT_ADDR = "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0";
const PAYOUT_WALLET = process.env.PAYOUT_WALLET || '0xSET_YOUR_WALLET';

const RPC_URLS = [process.env.QUICKNODE_HTTP || "https://mainnet.base.org", "https://base.drpc.org"];
const WSS_URLS = [process.env.QUICKNODE_WSS || "wss://base-rpc.publicnode.com", "wss://base.drpc.org"];

// Tokens and Routers for Base Mainnet
const TOKENS = { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const DEX_ROUTERS = { AERODROME: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", UNISWAP: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" };

const CONTRACT_ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external"
];

let provider, signer, flashContract, transactionNonce;
let currentRpcIndex = 0, currentWssIndex = 0, lastLogTime = Date.now();
let totalStrikes = 0, totalEarningsUSD = 0;

// ===============================================================================
// 2. HARDENED BOOT (Static Network Injection)
// ===============================================================================

async function initProvider() {
    try {
        const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
        const baseNetwork = ethers.Network.from(8453); 

        provider = new ethers.JsonRpcProvider(url, baseNetwork, { staticNetwork: baseNetwork });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, signer);
        
        await new Promise(r => setTimeout(r, 1000));
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        
        console.log(`[BOOT] RPC STABLE: ${url.slice(0,20)}... | Nonce: ${transactionNonce}`);
    } catch (e) {
        currentRpcIndex++;
        await initProvider();
    }
}

// ===============================================================================
// 3. FLASH EXECUTION ENGINE (The "Searcher" Logic)
// ===============================================================================

async function handleMempoolTx(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const isDex = Object.values(DEX_ROUTERS).some(r => r.toLowerCase() === tx.to.toLowerCase());
        
        // Trigger: Whales > 0.1 ETH (Smaller whales don't shift price enough for 100 ETH loan)
        if (isDex && tx.value > ethers.parseEther("0.1")) {
            lastLogTime = Date.now();
            console.log(`[🎯 TARGET] Whale detected: ${ethers.formatEther(tx.value)} ETH. Simulating...`);

            try {
                // StaticCall simulates the trade without spending money
                await flashContract.executeFlashArbitrage.staticCall(TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"));
                
                console.log("[🔥 PROFIT!] Simulation Passed. Launching 100 ETH Flash Loan...");
                
                const strikeTx = await flashContract.executeFlashArbitrage(TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"), {
                    gasLimit: 650000,
                    maxPriorityFeePerGas: ethers.parseUnits('0.15', 'gwei'), // Competitive tip
                    nonce: transactionNonce++
                });

                console.log(`[⚡ SENT] Flash Loan Tx: ${strikeTx.hash}`);
                const receipt = await strikeTx.wait();
                if (receipt.status === 1) {
                    totalStrikes++;
                    console.log(`[SUCCESS] 100 ETH Arb Complete!`);
                }
            } catch (simErr) {
                // Simulation failed (Not profitable) - we saved gas by not sending.
            }
        }
    } catch (e) {
        if (e.message.includes("limit")) { currentRpcIndex++; await initProvider(); }
    }
}

// ===============================================================================
// 4. WITHDRAWAL STRATEGIES & API
// ===============================================================================

const STRATS = ['standard-eoa', 'check-before', 'contract-call', 'timed-release', 'micro-split'];
STRATS.forEach(id => {
    app.post(`/withdraw/${id}`, async (req, res) => {
        try {
            const tx = await flashContract.withdraw(); // Withdraw from contract back to wallet
            await tx.wait();
            res.json({ success: true, tx: tx.hash });
        } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
});

app.get('/status', async (req, res) => {
    try {
        const bal = await provider.getBalance(signer.address);
        const contractBal = await flashContract.getContractBalance();
        res.json({
            status: "ONLINE",
            wallet_eth: ethers.formatEther(bal),
            contract_weth: ethers.formatEther(contractBal),
            performance: { strikes: totalStrikes, active_loan_size: "100 ETH" }
        });
    } catch (e) { res.json({ status: "RECONNECTING" }); }
});

// ===============================================================================
// 5. LISTENER & HEARTBEAT
// ===============================================================================

function startListener() {
    const wssUrl = WSS_URLS[currentWssIndex % WSS_URLS.length];
    const wssProvider = new ethers.WebSocketProvider(wssUrl);

    const heartbeat = setInterval(() => {
        const idle = (Date.now() - lastLogTime) / 1000;
        console.log(`[STATUS] Hunting Whales... Idle: ${idle.toFixed(0)}s`);
        if (idle > 200) { 
            clearInterval(heartbeat); wssProvider.destroy(); 
            currentWssIndex++; startListener(); 
        }
    }, 45000);

    wssProvider.on("pending", (h) => handleMempoolTx(h));
}

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER] v12.2.0 FLASH ENGINE ONLINE - PORT ${PORT}`);
        startListener();
    });
});
