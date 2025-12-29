require('dotenv').config();
const { ClientSecretCredential } = require("@azure/identity");
const { ComputeManagementClient } = require("@azure/arm-compute");
const axios = require("axios");

// --- INITIALISATION ---
const config = {
    rg: process.env.AZURE_RESOURCE_GROUP,
    vm: process.env.AZURE_VM_NAME,
    interval: (process.env.CHECK_INTERVAL_SECONDS || 60) * 1000,
    grafanaUri : process.env.GRAFANA_URI 
};

console.log("🤖 Spot Bot Initialized.");
console.log(`🎯 Target: VM '${config.vm}' in '${config.rg}'`);
console.log(`⏱️ Frequency: Every ${config.interval / 1000} seconds`);

// Azure Client
const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID,
    process.env.AZURE_CLIENT_ID,
    process.env.AZURE_CLIENT_SECRET
);
const computeClient = new ComputeManagementClient(credential, process.env.AZURE_SUBSCRIPTION_ID);

// --- MAIN LOOP ---
async function runCheckLoop() {
    try {
        await checkAndAct();
    } catch (error) {
        console.error("❌ Error in main loop:", error.message);
    } finally {
        // Restart the loop after the defined delay
        setTimeout(runCheckLoop, config.interval);
    }
}

// --- BUSINESS LOGIC ---
async function checkAndAct() {
    process.stdout.write(`[${new Date().toLocaleTimeString()}] Checking... `);

    try {
        // 1. Retrieve status
        const instanceView = await computeClient.virtualMachines.instanceView(config.rg, config.vm);
        const powerState = instanceView.statuses.find(s => s.code.startsWith("PowerState/"));
        const stateCode = powerState ? powerState.code : "Unknown";

        console.log(`State: ${stateCode}`);

        // 2. Decision
        if (stateCode === "PowerState/running") {
            // ALL GOOD
            await sendToGrafana(1); 
        } 
        else if (stateCode === "PowerState/deallocated") {
            // RED ALERT: SPOT EVICTION LIKELY
            console.log("⚠️ VM deallocated! Attempting to start...");
            await sendToGrafana(0); // Report DOWN
            
            // Attempt restart
            await startVM();
        } 
        else {
            // OTHER (Stopped, Starting, etc.)
            await sendToGrafana(0);
        }

    } catch (error) {
        console.error("\n❌ Azure API error:", error.message);
    }
}

async function startVM() {
    try {
        const startPoller = await computeClient.virtualMachines.beginStart(config.rg, config.vm);
        console.log("🚀 Start command sent, waiting...");
        
        await startPoller.pollUntilDone();
        console.log("✅ VM successfully restarted!");
        
        await sendTeamsAlert("✅ VM Saved", `The Spot VM **${config.vm}** has been successfully restarted by the bot.`, false);
        await sendToGrafana(1);

    } catch (error) {
        console.error("🔥 Restart failure:", error.message);
        
        await sendTeamsAlert(
            "🔥 Critical Spot VM Failure", 
            `The VM **${config.vm}** is down and the bot cannot restart it (Probably out of Spot quota or price too high).\n\nError: ${error.message}`, 
            true
        );
    }
}

// --- CONNECTORS ---

async function sendToGrafana(value) {
    if (!config.grafanaUri) return;

    // Clean the name (dots and dashes are ok, avoid spaces)
    const cleanVmName = config.vm.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    
    const payload = [{
        name: `azure.vm.${cleanVmName}.up`,
        value: value,
        time: Math.floor(Date.now() / 1000),
        interval: config.interval / 1000
    }];

    try {
        await axios.post(config.grafanaUri, payload, {
            auth: {
                username: process.env.GRAFANA_USER,
                password: process.env.GRAFANA_TOKEN
            },
            // Forcing JSON to avoid the 415 error
            headers: {
                'Content-Type': 'application/json'
            }
        });
        // console.log(`📊 Grafana pushed (JSON): ${value}`);
    } catch (error) {
        console.error("⚠️ Grafana Error:", error.response ? error.response.status : error.message);
        if (error.response && error.response.data) {
            console.error("   Detail:", JSON.stringify(error.response.data));
        }
    }
}

async function sendTeamsAlert(title, text, isError) {
    if (!process.env.TEAMS_WEBHOOK_URL) return;

    // --- ADAPTIVE CARD FORMAT (For Power Automate / Workflows) ---
    const payload = {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "msteams": { "width": "Full" },
                    "body": [
                        {
                            "type": "Container",
                            "items": [
                                {
                                    "type": "TextBlock",
                                    "text": title,
                                    "weight": "Bolder",
                                    "size": "Medium",
                                    "color": isError ? "Attention" : "Good" // "Attention" = Red, "Good" = Green (on some versions) or "Accent"
                                },
                                {
                                    "type": "TextBlock",
                                    "text": text,
                                    "wrap": true
                                }
                            ]
                        }
                    ]
                }
            }
        ]
    };

    try {
        await axios.post(process.env.TEAMS_WEBHOOK_URL, payload);
        console.log("📨 Teams message sent (Adaptive Card).");
    } catch (error) {
        console.error("❌ Teams error:", error.response ? error.response.data : error.message);
    }
}

// Launch
runCheckLoop();