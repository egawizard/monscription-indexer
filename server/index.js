import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import sqlite3 from "better-sqlite3";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// === Konfigurasi ===
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x07169f0F890C3595421512D98DC79b8bce6E5fA6";
const START_BLOCK = parseInt(process.env.START_BLOCK || "0");

// === Setup provider & contract ABI ===
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const abi = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

// === Database SQLite ===
const db = sqlite3("tokens.db");
db.prepare(`
  CREATE TABLE IF NOT EXISTS tokens (
    tokenId TEXT PRIMARY KEY,
    owner TEXT,
    lastUpdate INTEGER
  )
`).run();

// === WebSocket server untuk broadcast realtime ===
const wss = new WebSocketServer({ noServer: true });
let sockets = [];

wss.on("connection", (ws) => {
  sockets.push(ws);
  ws.on("close", () => {
    sockets = sockets.filter((s) => s !== ws);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  sockets.forEach((ws) => {
    try { ws.send(msg); } catch {}
  });
}

// === API endpoints ===
app.get("/api/health", async (req, res) => {
  try {
    const block = await provider.getBlockNumber();
    res.json({ status: "ok", block });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tokens", (req, res) => {
  const rows = db.prepare("SELECT * FROM tokens ORDER BY lastUpdate DESC LIMIT 100").all();
  res.json(rows);
});

// === Server HTTP + Upgrade untuk WebSocket ===
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// === Indexer loop ===
async function indexerLoop() {
  let latestIndexed = START_BLOCK;

  // Jika sudah ada data di DB, lanjut dari block terakhir
  const row = db.prepare("SELECT MAX(lastUpdate) as lastUpdate FROM tokens").get();
  if (row && row.lastUpdate) {
    latestIndexed = row.lastUpdate;
  }

  while (true) {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock > latestIndexed) {
        const fromBlock = latestIndexed + 1;
        const toBlock = Math.min(currentBlock, fromBlock + 50);

        console.log(`Indexing blocks ${fromBlock} → ${toBlock}`);

        const events = await contract.queryFilter("Transfer", fromBlock, toBlock);
        for (const ev of events) {
          const { from, to, tokenId } = ev.args;
          db.prepare(`
            INSERT INTO tokens (tokenId, owner, lastUpdate)
            VALUES (?, ?, ?)
            ON CONFLICT(tokenId) DO UPDATE SET owner=excluded.owner, lastUpdate=excluded.lastUpdate
          `).run(tokenId.toString(), to, ev.blockNumber);

          broadcast({ tokenId: tokenId.toString(), owner: to, block: ev.blockNumber });
        }

        latestIndexed = toBlock;
      }
    } catch (err) {
      console.error("Indexer error:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
}

indexerLoop();
