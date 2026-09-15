import {
  Message,
  Attachment,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  TextChannel,
  ButtonStyle,
} from 'discord.js';
import { Mutex } from 'async-mutex';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import logger from '../utils/logger.js';
import params from '../../params.json' with { type: 'json' };
import { compileLatexToPdfBuffer, LatexCompilationError } from '../utils/compileLaTeX.js';
import { ollamaGenerate } from '../utils/ollama.js';
import client from '../client.js';

const speachesUrl = 'http://mp2i-stt:8000/v1/audio/transcriptions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptsPath = join(__dirname, '../../prompts');

const templatePath = join(__dirname, '../../templates', 'document.tex');
const sttPromptPath = join(promptsPath, 'stt-prompt.md');
const latexSystemPromptPath = join(promptsPath, 'latex-system.md');
const latexUserPromptPath = join(promptsPath, 'latex-user.md');
const latexRepairPromptPath = join(promptsPath, 'latex-repair-system.md');

export interface ProcessResult {
  attachment: Attachment;
  transcript: string;
  latex: string;
}

class OralConverter {
  private channelId: string = params.channels.oral_result;
  private guild: any = null;
  private readonly sttMutex = new Mutex();
  private readonly llmMutex = new Mutex();

  public async init() {
    logger.info('OralConverter: Initializing...');

    let channel = client.channels.cache.get(this.channelId) as TextChannel | null;

    if (!channel) {
      try {
        channel = (await client.channels.fetch(this.channelId)) as TextChannel | null;
      } catch (fetchErr) {
        logger.error(`OralConverter: Failed to fetch channel ${this.channelId}: ${String(fetchErr)}`);
        return;
      }
    }

    channel = channel as TextChannel;
    this.guild = channel.guild;

    logger.info('OralConverter: Initialized.');
  }

  private async loadFile(path: string): Promise<string> {
    return await readFile(path, 'utf8');
  }

  private extractAudioAttachment(message: Message): Attachment {
    if (!message?.attachments || message.attachments.size === 0) {
      throw new Error('STT: No attachments found in the Discord message.');
    }

    const audioAttachment = message.attachments.find((att) => {
      const isAudioType = att.contentType?.startsWith('audio/');
      const isAudioExt = /\.(ogg|wav|mp3|m4a|flac)$/i.test(att.name);

      return Boolean(isAudioType || isAudioExt);
    });

    if (!audioAttachment) {
      throw new Error('STT: No valid audio attachment (.ogg, .wav, .mp3, .m4a, .flac) found in message.');
    }

    return audioAttachment;
  }

  private async downloadAudioBuffer(url: string): Promise<Buffer> {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`STT: Failed to download audio from Discord CDN: HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async transcribe(audioBuffer: Buffer, filename = 'voice.ogg'): Promise<string> {
    return await this.sttMutex.runExclusive(async () => {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' });

      formData.append('file', blob, filename);
      formData.append('model', 'deepdml/faster-whisper-large-v3-turbo-ct2');
      formData.append('language', 'fr');
      formData.append('temperature', '0.0');
      formData.append('vad_filter', 'true');

      const sttPrompt = await this.loadFile(sttPromptPath);
      formData.append('prompt', sttPrompt);

      const res = await fetch(speachesUrl, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`STT: failed [HTTP ${res.status}]: ${errText}`);
      }

      const data = (await res.json()) as { text: string };
      return data.text.trim();
    });
  }

  private async generateLatex(transcript: string): Promise<string> {
    return await this.llmMutex.runExclusive(async () => {
      const systemPrompt = await this.loadFile(latexSystemPromptPath);
      const userPromptTemplate = await this.loadFile(latexUserPromptPath);
      const userPrompt = userPromptTemplate.replace('{{TRANSCRIPTION}}', transcript);

      return await ollamaGenerate(params.ml.ollama_model, systemPrompt, userPrompt, {
        num_ctx: 4096,
        temperature: 0.1,
      });
    });
  }

  private async repairLatex(latex: string, error: LatexCompilationError): Promise<string> {
    return await this.llmMutex.runExclusive(async () => {
      const systemPrompt = await this.loadFile(latexRepairPromptPath);

      const repairPrompt = `
Voici le code LaTeX complet qui ne compile pas :

<latex>
${latex}
</latex>

Voici le log de compilation produit par pdflatex :

<latex_error>
${error.latexLog}
</latex_error>

Corrige uniquement les erreurs LaTeX nécessaires pour permettre la compilation.

Retourne uniquement le contenu LaTeX situé entre
\\begin{document} et \\end{document}.

Ne retourne PAS :
- \\documentclass
- \\usepackage
- \\begin{document}
- \\end{document}

Ne résous pas l'exercice.
Ne change pas les nombres.
Ne change pas le contenu mathématique.
`;

      return await ollamaGenerate(params.ml.repair_model, systemPrompt, repairPrompt, {
        num_ctx: 4096,
        temperature: 0.0,
      });
    });
  }

  private async buildLatexDocument(latexContent: string, username: string): Promise<string> {
    const template = await this.loadFile(templatePath);
    const now = new Date();

    const dateText = new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Europe/Paris',
    }).format(now);

    return template
      .replaceAll('{{USER}}', username)
      .replaceAll('{{DATE}}', dateText)
      .replace('{{CONTENT}}', latexContent);
  }

  private async compileWithRepair(
    latex: string,
    username: string
  ): Promise<{ latex: string; pdf: Buffer }> {
    let currentLatex = latex;
    const maxRepairAttempts = 2;

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
      try {
        const document = await this.buildLatexDocument(currentLatex, username);
        const pdf = await compileLatexToPdfBuffer(document, username);

        return {
          latex: currentLatex,
          pdf,
        };
      } catch (error) {
        if (!(error instanceof LatexCompilationError)) {
          throw error;
        }

        if (attempt >= maxRepairAttempts) {
          throw error;
        }

        logger.warn(
          `LaTeX compilation failed. Repair attempt ${attempt + 1}/${maxRepairAttempts}.`
        );

        currentLatex = await this.repairLatex(currentLatex, error);
      }
    }

    throw new Error('LaTeX compilation failed unexpectedly.');
  }

  public async processAudioMessage(message: Message): Promise<void> {
    logger.info(`Processing voice message from ${message.author.tag} (${message.id})`);

    try {
      const attachment = this.extractAudioAttachment(message);
      const audioBuffer = await this.downloadAudioBuffer(attachment.url);

      logger.info(`Transcribing audio attachment: ${attachment.name}`);
      const transcript = await this.transcribe(audioBuffer, attachment.name);

      logger.info(`Generating LaTeX for transcript: "${transcript}"`);
      const latex = await this.generateLatex(transcript);

      const result = await this.compileWithRepair(latex, message.author.displayName);

      const pdfAttachment = new AttachmentBuilder(result.pdf, {
        name: 'oral.pdf',
      });

      const contentText = transcript ? `**Transcription :** ${transcript}` : 'Not Found';

      const oralEmbed = new EmbedBuilder()
        .setAuthor({
          name: `Oral de ${message.author.displayName}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setDescription(contentText.slice(0, 6000))
        .setColor('#900D09');

      const channel = (await this.guild.channels.fetch(this.channelId)) as TextChannel;

      await channel.send({
        embeds: [oralEmbed],
        files: [pdfAttachment],
      });

      logger.info(`Successfully processed voice message (${message.id})`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      } else {
        console.error(error);
      }
    }
  }

  public async processTextMessage(message: Message): Promise<void> {
    logger.info(`Generating LaTeX for message (${message.id})`);

    try {
      const latex = await this.generateLatex(message.content);
      const result = await this.compileWithRepair(latex, message.author.displayName);

      const pdfAttachment = new AttachmentBuilder(result.pdf, {
        name: 'oral.pdf',
      });

      const contentText = message.content
        ? `**Texte Original :** ${message.content}`
        : 'Not Found';

      const oralEmbed = new EmbedBuilder()
        .setAuthor({
          name: `Oral de ${message.author.username}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setDescription(contentText.slice(0, 6000))
        .setColor('#900D09');

      const channel = (await this.guild.channels.fetch(this.channelId)) as TextChannel;

      await channel.send({
        embeds: [oralEmbed],
        files: [pdfAttachment],
      });

      logger.info(`Successfully processed text message (${message.id})`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      } else {
        console.error(error);
      }
    }
  }

  public async replyInChannel(message: Message): Promise<void> {
    if (message.content.length <= 10 && message.attachments.size === 0) {
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`process_text-${message.id}`)
        .setLabel('Traiter le texte')
        .setStyle(ButtonStyle.Success)
    );

    if (message.attachments && message.attachments.size !== 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`process_audio-${message.id}`)
          .setLabel("Traiter l'audio")
          .setStyle(ButtonStyle.Success)
      );
    }

    const actionEmbed = new EmbedBuilder()
      .setDescription('Comment voulez-vous traiter le message ?')
      .setColor(0x3498db);

    await message.reply({
      embeds: [actionEmbed],
      components: [row],
    });
  }
}

export default new OralConverter();
