// ===============================================================================
// MASTER ENGINE v12.3.0 (FLASH LOAN + AGGRESSIVE GAS + LIVE REPORTING)
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

const RPC_URLS = [process.env.QUICKNODE_HTTP || "https://mainnet.base.org", "https://base.drpc.org"];
const WSS_URLS = [process.env.QUICKNODE_WSS || "wss://base-rpc.publicnode.com", "wss://base.drpc.org"];

const TOKENS = { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const DEX_ROUTERS = { AERODROME: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", UNISWAP: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" };

const CONTRACT_ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external"
];

let provider, signer, flashContract, transactionNonce;
let currentRpcIndex = 0, currentWssIndex = 0, lastLogTime = Date.now();
let successfulStrikes = 0;

// ===============================================================================
// 2. INITIALIZATION & BALANCE TRACKER
// ===============================================================================

async function initProvider() {
    try {
        const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
        const baseNetwork = ethers.Network.from(8453); 

        provider = new ethers.JsonRpcProvider(url, baseNetwork, { staticNetwork: baseNetwork });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, signer);
        
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        
        const bal = await provider.getBalance(signer.address);
        console.log(`\n--- ENGINE STARTING ---`);
        console.log(`[WALLET] ETH: ${ethers.formatEther(bal)}`);
        console.log(`[NODE] Active: ${url.includes('quiknode') ? 'QUICKNODE (FAST)' : 'Public (Slow)'}`);
        console.log(`[NONCE] Current: ${transactionNonce}\n`);
    } catch (e) {
        currentRpcIndex++;
        await initProvider();
    }
}

// ===============================================================================
// 3. AGGRESSIVE EXECUTION (Winning the Gas War)
// ===============================================================================

async function executeStrike(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const isDex = Object.values(DEX_ROUTERS).some(r => r.toLowerCase() === tx.to.toLowerCase());
        
        // Increased threshold to 0.2 ETH to ensure the profit covers the "Aggressive Gas"
        if (isDex && tx.value > ethers.parseEther("0.2")) {
            lastLogTime = Date.now();
            console.log(`[🎯 TARGET] Whale: ${ethers.formatEther(tx.value)} ETH. Running Simulation...`);

            try {
                // 1. Simulate the trade
                await flashContract.executeFlashArbitrage.staticCall(TOKENS.WETH, TOKENS.USDC, ethers.parseEther("100"));
                
                console.log("[🔥 PROFIT DETECTED] Bidding for Block Priority...");

                // 2. High-Priority Execution
                const strikeTx = await flashContract.executeFlashArbitrage(
                    TOKENS.WETH, 
                    TOKENS.USDC, 
                    ethers.parseEther("100"), 
                    {
                        gasLimit: 750000,
                        // AGGRESSIVE GAS: 1.5 Gwei tip to jump ahead of other bots
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
                // Trade would have failed/lost money
            }
        }
    } catch (e) {
        if (e.message.includes("limit")) { currentRpcIndex++; await initProvider(); }
    }
}

// ===============================================================================
// 4. API STATUS (Balance in JSON)
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

// ===============================================================================
// 5. BOOT & LISTEN
// ===============================================================================

function startScanning() {
    const wssUrl = WSS_URLS[currentWssIndex % WSS_URLS.length];
    const wssProvider = new ethers.WebSocketProvider(wssUrl);

    wssProvider.on("pending", (h) => executeStrike(h));

    setInterval(() => {
        const idle = (Date.now() - lastLogTime) / 1000;
        console.log(`[SCAN] Active. Idle: ${idle.toFixed(0)}s | Wins: ${successfulStrikes}`);
        if (idle > 300) { process.exit(1); } // PM2 will restart if connection dies
    }, 60000);
}

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SYSTEM] Master Engine v12.3.0 Live on Port ${PORT}`);
        startScanning();
    });
});
