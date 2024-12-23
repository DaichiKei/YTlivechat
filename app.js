import { Masterchat, stringify } from 'masterchat';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import express from 'express';

const app = express();
const port = 3000;

// Endpoint root
app.get('/', (req, res) => {
    res.send('Hello World');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
dotenv.config();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const TOKEN = process.env.TOKEN;

// Structure to store data per guild
const guildData = {};

// Delay function
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to get the file path for each guild
function getFilePath(guildId) {
    return path.resolve('./', `chats_${guildId}.json`);
}

// Initialize JSON file if it doesn't exist
function initializeDataFile(guildId) {
    const filePath = getFilePath(guildId);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify([], null, 2));
    }
}

// Function to delete the JSON file for a specific guild
function deleteDataFile(guildId) {
    const filePath = getFilePath(guildId);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`chats_${guildId}.json has been deleted.`);
    }
    if (fs.existsSync(`output_${guildId}.mp3`)) {
        fs.unlinkSync(`output_${guildId}.mp3`);
        console.log(`output_${guildId}.mp3 has been deleted.`);
    }
}

// Read JSON data into cache for a specific guild
function loadCache(guildId) {
    initializeDataFile(guildId);
    const filePath = getFilePath(guildId);
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        guildData[guildId].chatCache = JSON.parse(rawData) || [];
        guildData[guildId].nextId = guildData[guildId].chatCache.length ? Math.max(...guildData[guildId].chatCache.map(item => item.id)) + 1 : 1;
    } catch (error) {
        console.error('Error loading data:', error.message);
        guildData[guildId].chatCache = [];
    }
}

// Save cache to JSON file for a specific guild
function saveCache(guildId) {
    const filePath = getFilePath(guildId);
    fs.writeFileSync(filePath, JSON.stringify(guildData[guildId].chatCache, null, 2));
}

// Create a new chat entry in cache
function createData(newData, guildId) {
    newData.id = guildData[guildId].nextId++;
    guildData[guildId].chatCache.push(newData);
    saveCache(guildId);
}

// Process and play unplayed chats
async function processChats(guildId) {
    if (guildData[guildId].isProcessing || guildData[guildId].shouldStop) return;
    guildData[guildId].isProcessing = true;

    for (const chat of guildData[guildId].chatCache.filter(c => !c.played)) {
        if (guildData[guildId].shouldStop) break;
        console.log(`Pesan dari ${chat.name}, ${chat.message} [${guildId}]`);
        await playTextAsSpeech(`Pesan dari ${chat.name}, ${chat.message}`, guildData[guildId].connection, guildId);

        chat.played = true;
    }

    saveCache(guildId);
    guildData[guildId].isProcessing = false;
}

// Maximum length for Google TTS text
const MAX_TTS_LENGTH = 200;

// Convert text to speech and play in Discord voice channel
async function playTextAsSpeech(text, connection, guildId) {
    return new Promise(async (resolve, reject) => {
        // Trim text to fit within Google TTS limit
        const truncatedText = text.length > MAX_TTS_LENGTH 
            ? text.substring(0, MAX_TTS_LENGTH) 
            : text;

        if (guildData[guildId].shouldStop) return resolve();

        const outputFilePath = `output_${guildId}.mp3`; // Unique output for each guild

        ffmpeg()
            .input(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(truncatedText)}&tl=id&client=tw-ob`)
            .output(outputFilePath) // Output to a unique file
            .on('end', async () => {
                try {
                    guildData[guildId].player = createAudioPlayer();
                    const resource = createAudioResource(outputFilePath);
                    guildData[guildId].player.play(resource);
                    await connection.subscribe(guildData[guildId].player);

                    guildData[guildId].player.on(AudioPlayerStatus.Playing, () => {
                        console.log(`Playing audio for guild ${guildId}...`);
                    });

                    guildData[guildId].player.on(AudioPlayerStatus.Idle, () => {
                        fs.unlink(outputFilePath, err => {
                            if (err) console.error(`Error deleting audio file: ${err}`);
                        });
                        guildData[guildId].player.stop();
                        resolve();
                    });
                } catch (error) {
                    reject(error);
                }
            })
            .on('error', reject)
            .run();
    });
}

// Fetch live chat messages and store in cache
async function fetchLiveChat(liveId, guildId) {
    try {
        const mc = await Masterchat.init(liveId);
        const chats = mc.iter().filter(action => action.type === 'addChatItemAction');
        for await (const chat of chats) {
            if (guildData[guildId].shouldStop) break;
            createData({
                name: chat.authorName,
                message: stringify(chat.message),
                played: false
            }, guildId);
        }
    } catch (err) {
        console.error('Error fetching live chat:', err.message);
    }
}

// Reset process flags and delete file for each guild
async function resetGuildData(guildId) {
    guildData[guildId].shouldStop = true;
    guildData[guildId].isProcessing = false;

    deleteDataFile(guildId);
    guildData[guildId].chatCache = [];
    await delay(1000);
    guildData[guildId].shouldStop = false;
    initializeDataFile(guildId);
}

// Discord bot setup and command to join voice channel
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const guildId = interaction.guild.id;

    // Initialize guild-specific data if it doesn't exist
    if (!guildData[guildId]) {
        guildData[guildId] = {
            chatCache: [],
            nextId: 1,
            isProcessing: false,
            shouldStop: false,
            connection: null,
            player: null
        };
    }

    // Defer reply to give the bot more time to process
    await interaction.deferReply();

    // Reset guild-specific process flags and delete file on each command
    await resetGuildData(guildId);

    if (interaction.commandName === 'join') {
        const liveId = interaction.options.getString('liveid');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.followUp("Kamu harus berada di voice channel terlebih dahulu!");
        }

        if (!liveId) {
            return interaction.followUp("Silakan berikan liveId yang valid!");
        }

        try {
            guildData[guildId].connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            await interaction.followUp("Bot sudah bergabung ke voice channel.");

            setInterval(async () => {
                if (guildData[guildId].shouldStop) return;
                await processChats(guildId);
            }, 5000);

            fetchLiveChat(liveId, guildId);
        } catch (error) {
            console.error(error);
            await interaction.followUp("Terjadi kesalahan saat mencoba bergabung ke voice channel.");
        }
    }

    if (interaction.commandName === 'stop') {
        await resetGuildData(guildId);

        if (guildData[guildId].connection) {
            try {
                guildData[guildId].player.stop();
                await delay(1000);

                guildData[guildId].connection.destroy();
                guildData[guildId].connection = null;
                await interaction.followUp("Bot telah meninggalkan voice channel dan semua proses dihentikan.");
            } catch (error) {
                console.error("Error leaving the voice channel:", error);
                await interaction.followUp("Terjadi kesalahan saat mencoba meninggalkan voice channel.");
            }
        } else {
            await interaction.followUp("Bot tidak terhubung ke voice channel mana pun.");
        }
    }
});

// Global error handlers
process.on('uncaughtException', (error) => {
    console.error("Uncaught Exception:", error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error("Unhandled Rejection:", reason);
});

// Run the main functions
(async () => {
    await client.login(TOKEN);
})();
