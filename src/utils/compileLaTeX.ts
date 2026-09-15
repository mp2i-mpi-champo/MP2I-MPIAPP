import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime } from 'luxon';

import logger from './logger.js';

const execFileAsync = promisify(execFile);

export class LatexCompilationError extends Error {
    public readonly latexLog: string;
    public readonly latexSource: string;

    constructor(
        message: string,
        latexLog: string,
        latexSource: string
    ) {
        super(message);

        this.name = 'LatexCompilationError';
        this.latexLog = latexLog;
        this.latexSource = latexSource;
    }
}

export async function compileLatexToPdfBuffer(
    document: string,
    user: string
): Promise<Buffer> {
    const tempDir = await mkdtemp(
        join(tmpdir(), 'latex-compile-')
    );

    const texPath = join(
        tempDir,
        'document.tex'
    );

    const pdfPath = join(
        tempDir,
        'document.pdf'
    );

    const logPath = join(
        tempDir,
        'document.log'
    );

    const now = DateTime
        .now()
        .setLocale('fr')
        .setZone('Europe/Paris');

    let dateText = now.toFormat(
        "cccc d MMMM yyyy 'à' HH'h'mm"
    );

    dateText =
        dateText.charAt(0).toUpperCase() +
        dateText.slice(1);

    /*
     * Le template est maintenant construit dans OralConverter.
     *
     * On ajoute ici uniquement les informations
     * spécifiques à l'utilisateur/date si elles
     * n'ont pas déjà été intégrées au template.
     *
     * Pour l'instant, le document reçu est utilisé tel quel.
     */
    const finalDocument = document;

    try {
        await writeFile(
            texPath,
            finalDocument,
            'utf8'
        );

        await execFileAsync(
            'pdflatex',
            [
                '-interaction=nonstopmode',
                '-halt-on-error',
                '-output-directory',
                tempDir,
                texPath
            ],
            {
                maxBuffer: 10 * 1024 * 1024
            }
        );

        return await readFile(
            pdfPath
        );
    } catch (error) {
        let latexLog = '';

        try {
            latexLog = await readFile(
                logPath,
                'utf8'
            );

            const lines =
                latexLog.split('\n');

            /*
             * On conserve une partie suffisamment
             * importante du log pour permettre au
             * modèle réparateur de comprendre
             * l'erreur.
             */
            latexLog =
                lines
                    .slice(-80)
                    .join('\n');
        } catch {
            latexLog =
                'No log file generated. ' +
                'pdflatex may be missing or failed to start.';
        }

        logger.error(
            `LaTeX compilation failed:\n${latexLog}`
        );

        logger.error(
            `LaTeX source:\n${finalDocument}`
        );

        const errorMessage =
            error instanceof Error
                ? error.message
                : 'Unknown error';

        throw new LatexCompilationError(
            `pdflatex compilation failed: ${errorMessage}`,
            latexLog,
            finalDocument
        );
    } finally {
        await rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        ).catch(() => {});
    }
}