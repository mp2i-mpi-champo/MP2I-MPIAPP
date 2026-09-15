import logger from '../utils/logger.js';
import { TextChannel, AttachmentBuilder } from 'discord.js';
import MessageId from '../database/models/MessageId.js';
import params from '../../params.json' with { type: 'json' };
import client from '../client.js';
import * as pureimage from 'pureimage';
import { PassThrough } from 'stream';
import { DateTime } from 'luxon';

type WeekType = 'A' | 'B';
type DayOfWeek = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
type Course = {
    name: string;
    start: string;
    end: string;
    group: string;
    color: string;
    class: string;
};

type Schedule = {
    [week in WeekType]: {
        [day in DayOfWeek]: Course[];
    };
};

const dejaFont = pureimage.registerFont('/usr/share/fonts/dejavu/DejaVuSans.ttf', 'DejaVuSans');
dejaFont.loadSync();

// Colors used for courses, can be customized in param.json
const LIGHT_BLUE = '#2196f3';
const DARK_GREEN = '#388e3c';
const DARK_ORANGE = '#e65100';
const DARK_GRAY = '#616161';
const BLACK = '#000000';
const YELLOW = '#B8860B';
const MUD = '#60544c';
const LIGHT_PURPLE = '#7c4dff';

class EmploiDuTemps {
    private dailyEmbedMessageId: string | null = null;
    private weeklyEmbedMessageId : string | null = null;
    private schedule: Schedule = params.emploiDuTemps;

    public async getDayImageBuffer(week: WeekType, date: Date): Promise<Buffer> {
        const dayNames: DayOfWeek[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const day: DayOfWeek = dayNames[date.getDay()];
        const courses = this.getCourses(week, day);

        const dayNamesFr: { [key in DayOfWeek]: string } = {
            Monday: 'Lundi',
            Tuesday: 'Mardi',
            Wednesday: 'Mercredi',
            Thursday: 'Jeudi',
            Friday: 'Vendredi',
            Saturday: 'Samedi',
            Sunday: 'Dimanche',
        };

        const dayNum = date.getDate().toString().padStart(2, '0');
        const monthNamesFr = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
        const monthName = monthNamesFr[date.getMonth()];

        const startHour = 8;
        const endHour = 19;
        const hourHeight = 60;
        const leftMargin = 120;
        const width = 800;
        const height = 100 + (endHour - startHour) * hourHeight + 40;

        const img = pureimage.make(width, height);
        const ctx = img.getContext('2d');

        // Background
        ctx.fillStyle = '#23272a';
        ctx.fillRect(0, 0, width, height);

        ctx.font = '32pt DejaVuSans';
        ctx.fillStyle = '#fff';
        const titleText = `${dayNamesFr[day]} ${dayNum} ${monthName} (semaine ${week})`;
        const titleWidth = ctx.measureText(titleText).width;
        const titleX = (width - titleWidth) / 2;
        ctx.fillText(titleText, titleX, 50);

        // Time axis
        ctx.strokeStyle = '#444851';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(leftMargin, 90);
        ctx.lineTo(leftMargin, height - 40);
        ctx.stroke();

        ctx.font = '20pt DejaVuSans';
        ctx.fillStyle = '#b9bbbe';
        for (let h = startHour; h <= endHour; h++) {
            const y = 90 + (h - startHour) * hourHeight;
            ctx.fillText(`${h}:00`, 40, y + 8);
            ctx.beginPath();
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.moveTo(leftMargin - 10, y);
            ctx.lineTo(width - 40, y);
            ctx.stroke();
        }

        type CourseBlock = { course: Course; index: number; overlap: number };
        const blocks: CourseBlock[] = [];
        courses.forEach((course, i) => {
            const overlap = courses.filter((c) => c.start === course.start && c.end === course.end).length;

            const index = courses.filter((c) => c.start === course.start && c.end === course.end).findIndex((c) => c === course);
            blocks.push({ course, index, overlap });
        });

        blocks.forEach(({ course, index, overlap }) => {
            const [startH, startM] = course.start.split(':').map(Number);
            const [endH, endM] = course.end.split(':').map(Number);

            const blockY = 90 + (startH + startM / 60 - startHour) * hourHeight;
            const blockHeight = (endH + endM / 60 - (startH + startM / 60)) * hourHeight;

            const totalWidth = width - leftMargin - 60;
            const blockWidth = totalWidth / overlap;
            const blockX = leftMargin + 10 + index * blockWidth;

            ctx.fillStyle = course.color;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;

            ctx.fillRect(blockX, blockY, blockWidth, blockHeight);
            ctx.strokeRect(blockX, blockY, blockWidth, blockHeight);

            ctx.font = '22pt DejaVuSans';
            ctx.fillStyle = '#fff';
            const courseNameWidth = ctx.measureText(course.name).width;
            const courseNameX = blockX + (blockWidth - courseNameWidth) / 2;
            ctx.fillText(`${course.name}`, courseNameX, blockY + 28);

            ctx.font = '18pt DejaVuSans';
            ctx.fillStyle = '#e0e0e0';
            let salleText = `Salle : ${course.class}`;
            const salleWidth = ctx.measureText(salleText).width;
            const salleX = blockX + (blockWidth - salleWidth) / 2;
           
            let group = '';
            switch (course.group) {
                case 'group1':
                    group = 'Groupe 1';
                    break;
                case 'group2':
                    group = 'Groupe 2';
                    break;
                case 'opts2i':
                    group = 'Opt SI';
                    break;
                case 'optinfo':
                    group = 'Opt Info';
                    break;
                case 'MPI':
                    group = 'MPI';
                    break;
                case 'MPI*':
                    group = 'MPI*';
                    break;
            }

	        if(group && endH - startH === 1) {
		        salleText += ' ' + group;
            	ctx.fillText(salleText, salleX, blockY + 54);
	        } else if (group) {
            	ctx.fillText(salleText, salleX, blockY + 54);
		        const groupWidth = ctx.measureText(group).width;
                const groupX = blockX + (blockWidth - groupWidth) / 2;
                ctx.fillText(group, groupX, blockY + 76);
            } else {
            	ctx.fillText(salleText, salleX, blockY + 54);
            }
        });

        const stream = new PassThrough();
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        await pureimage.encodePNGToStream(img, stream);
        return Buffer.concat(chunks);
    }

    public async getWeekImageBuffer(week: WeekType): Promise<Buffer> {
        const daysToDisplay: DayOfWeek[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const dayNamesFr: { [key in DayOfWeek]: string } = {
            Monday: 'Lundi', Tuesday: 'Mardi', Wednesday: 'Mercredi',
            Thursday: 'Jeudi', Friday: 'Vendredi', Saturday: 'Samedi', Sunday: 'Dimanche',
        };

        const startHour = 8;
        const endHour = 19;
        const hourHeight = 60;
        const leftMargin = 100;
        const dayWidth = 300; 
        const headerHeight = 100;
        const width = leftMargin + (dayWidth * daysToDisplay.length) + 40;
        const height = headerHeight + (endHour - startHour) * hourHeight + 40;

        const img = pureimage.make(width, height);
        const ctx = img.getContext('2d');

        // Background
        ctx.fillStyle = '#23272a';
        ctx.fillRect(0, 0, width, height);

        // Header Title
        ctx.font = '40pt DejaVuSans';
        ctx.fillStyle = '#fff';
        const titleText = `Emploi du Temps - Semaine ${week}`;
        ctx.fillText(titleText, leftMargin, 60);

        // Time Axis
        ctx.font = '18pt DejaVuSans';
        ctx.fillStyle = '#b9bbbe';
        for (let h = startHour; h <= endHour; h++) {
            const y = headerHeight + (h - startHour) * hourHeight;
            ctx.fillText(`${h}:00`, 20, y + 8);

            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(leftMargin, y);
            ctx.lineTo(width - 40, y);
            ctx.stroke();
        }

        // Days
        daysToDisplay.forEach((day, dayIdx) => {
            const colX = leftMargin + (dayIdx * dayWidth);
            const courses = this.getCourses(week, day);

            // Column Header (Day Name)
            ctx.font = '22pt DejaVuSans';
            ctx.fillStyle = '#fff';
            const dayText = dayNamesFr[day];
            const dayTextWidth = ctx.measureText(dayText).width;
            ctx.fillText(dayText, colX + (dayWidth - dayTextWidth) / 2, headerHeight - 20);

            // Vertical separator
            ctx.strokeStyle = '#444851';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(colX, headerHeight);
            ctx.lineTo(colX, height - 40);
            ctx.stroke();

            // Draw Courses for this day
            courses.forEach((course) => {
                const [startH, startM] = course.start.split(':').map(Number);
                const [endH, endM] = course.end.split(':').map(Number);

                const blockY = headerHeight + (startH + startM / 60 - startHour) * hourHeight;
                const blockHeight = (endH + endM / 60 - (startH + startM / 60)) * hourHeight;

                // Course Box
                ctx.fillStyle = course.color;
                ctx.fillRect(colX + 5, blockY, dayWidth - 10, blockHeight);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.strokeRect(colX + 5, blockY, dayWidth - 10, blockHeight);

                ctx.fillStyle = '#fff';
                ctx.font = '14pt DejaVuSans';
                ctx.fillText(course.name, colX + 15, blockY + 25);

                ctx.font = '12pt DejaVuSans';
                ctx.fillStyle = '#e0e0e0';
                ctx.fillText(course.class, colX + 15, blockY + 45);
            });
        });

        const stream = new PassThrough();
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        await pureimage.encodePNGToStream(img, stream);
        return Buffer.concat(chunks);
    }

    public async sendOrUpdateImages(week: WeekType, date: Date) {
        const channelId = params.channels.emploiDuTemps;
        const channel = client.channels.cache.get(channelId) as TextChannel;

        if (!this.dailyEmbedMessageId) {
            const dbEntry = await MessageId.findOne({ where: { name: 'emploiDuTemps' } });
            if (dbEntry && dbEntry.messageId) {
                this.dailyEmbedMessageId = dbEntry.messageId;
            }
        }

        const imageBuffer = await this.getDayImageBuffer(week, date);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'emploi_du_temps.png' });

        if (this.dailyEmbedMessageId) {
            try {
                const message = await channel.messages.fetch(this.dailyEmbedMessageId);
                await message.edit({ files: [attachment], content: '' });
                logger.info('EmploiDuTemps: Image message updated.');
            } catch (err) {
                logger.error('EmploiDuTemps: Failed to edit message, sending new one.');
                const sentMsg = await channel.send({ files: [attachment] });
                this.dailyEmbedMessageId = sentMsg.id;
                await MessageId.upsert({ name: 'emploiDuTemps', messageId: sentMsg.id });
            }
        } else {
            const sentMsg = await channel.send({ files: [attachment] });
            this.dailyEmbedMessageId = sentMsg.id;
            await MessageId.upsert({ name: 'emploiDuTemps', messageId: sentMsg.id });
            logger.info('EmploiDuTemps: Image message sent.');
        }

        if(date.getDay() === 0) {
            if (!this.weeklyEmbedMessageId) {
                const dbEntry = await MessageId.findOne({ where: { name: 'emploiDuTempsWeek' } });
                if (dbEntry && dbEntry.messageId) {
                this.weeklyEmbedMessageId = dbEntry.messageId;
                }
            }
            
            const imageBuffer = await this.getWeekImageBuffer(week === 'A' ? 'B' : 'A');
            const attachment = new AttachmentBuilder(imageBuffer, { name: 'emploi_du_temps.png' });

            if (this.weeklyEmbedMessageId) {
                try {
                    const message = await channel.messages.fetch(this.weeklyEmbedMessageId);
                    await message.edit({ files: [attachment], content: '' });
                    logger.info('EmploiDuTempsWeek: Image message updated.');
                } catch (err) {
                    logger.error('EmploiDuTempsWeek: Failed to edit message, sending new one.');
                    const sentMsg = await channel.send({ files: [attachment] });
                    this.weeklyEmbedMessageId = sentMsg.id;
                    await MessageId.upsert({ name: 'emploiDuTempsWeek', messageId: sentMsg.id });
                }
            } else {
                const sentMsg = await channel.send({ files: [attachment] });
                this.weeklyEmbedMessageId = sentMsg.id;
                await MessageId.upsert({ name: 'emploiDuTempsWeek', messageId: sentMsg.id });
                logger.info('EmploiDuTempsWeek: Image message sent.');
            }
        }
    }

    public async init() {
        logger.info('Emploi du temps initialized.');

        const dtParis = DateTime.now().setZone('Europe/Paris').plus({ days: 1 });
        const tomorrow = new Date(dtParis.year, dtParis.month - 1, dtParis.day);
        const currentWeek: WeekType = this.getCurrentWeekTypeForDate(tomorrow);

        await this.sendOrUpdateImages(currentWeek, tomorrow);

        this.scheduleDailyUpdate();
    }

    private scheduleDailyUpdate() {
        const getMsUntilNext19Paris = () => {
            const nowParis = DateTime.now().setZone('Europe/Paris');
            let nextUpdate = nowParis.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
            if (nowParis >= nextUpdate) {
                nextUpdate = nextUpdate.plus({ days: 1 });
            }
            return nextUpdate.toMillis() - nowParis.toMillis();
        };

        const loop = async () => {
            await this.dailyUpdate();
            setTimeout(loop, getMsUntilNext19Paris());
        };

        setTimeout(loop, getMsUntilNext19Paris());
    }

    private async dailyUpdate() {
        const dtParis = DateTime.now().setZone('Europe/Paris').plus({ days: 1 });
        const tomorrow = new Date(dtParis.year, dtParis.month - 1, dtParis.day);
        const currentWeek: WeekType = this.getCurrentWeekTypeForDate(tomorrow);

        await this.sendOrUpdateImages(currentWeek, tomorrow);
    }
  
    private getCurrentWeekTypeForDate(date: Date): WeekType {
        const reference = new Date(date.getFullYear(), 8, 1);
        const refMonday = new Date(reference);
        refMonday.setDate(reference.getDate() - ((reference.getDay() + 6) % 7));

        const nowMonday = new Date(date);
        nowMonday.setDate(date.getDate() - ((date.getDay() + 6) % 7));

        const diffWeeks = Math.floor((nowMonday.getTime() - refMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
        return diffWeeks % 2 === 0 ? 'A' : 'B';
    }

    public getCourses(week: WeekType, day: DayOfWeek): Course[] {
        return this.schedule[week][day];
    }

    public getWeekSchedule(week: WeekType): { [day in DayOfWeek]: Course[] } {
        return this.schedule[week];
    }
}

export default new EmploiDuTemps();
