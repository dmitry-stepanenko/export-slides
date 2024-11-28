// this is a simplified version of this util https://github.com/slidevjs/slidev/blob/main/packages/slidev/node/commands/export.ts
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import { Presets, SingleBar } from "cli-progress";
import fs from "fs-extra";
import { blue, cyan, dim, green, yellow } from "kolorist";
import { PDFDocument } from "pdf-lib";
import { range, uniq } from "@antfu/utils";

export interface ExportOptions {
    range?: string;
    meta?: {
        title: string;
        info: string;
        author: string;
        keywords: string;
    };
    port?: number;
    base?: string;
    format?: "pdf" | "png" | "pptx";
    output?: string;
    timeout?: number;
    wait?: number;
    waitUntil: "networkidle" | "load" | "domcontentloaded" | undefined;
    dark?: boolean;
    routerMode?: "hash" | "history";
    width?: number;
    height?: number;
    withClicks?: boolean;
    executablePath?: string;
    /**
     * Render slides slide by slide. Works better with global components, but will break cross slide links and TOC in PDF.
     * @default false
     */
    perSlide?: boolean;
    scale?: number;
    omitBackground?: boolean;
}

interface ExportPngResult {
    slideIndex: number;
    buffer: Buffer;
}

export interface ExportNotesOptions {
    port?: number;
    base?: string;
    output?: string;
    timeout?: number;
    wait?: number;
}

function createSlidevProgress(indeterminate = false) {
    function getSpinner(n = 0) {
        return [cyan("●"), green("◆"), blue("■"), yellow("▲")][n % 4];
    }
    let current = 0;
    let spinner = 0;
    let timer: any;

    const progress = new SingleBar(
        {
            clearOnComplete: true,
            hideCursor: true,
            format: `  {spin} ${yellow("rendering")}${indeterminate ? dim(yellow("...")) : " {bar} {value}/{total}"}`,
            linewrap: false,
            barsize: 30,
        },
        Presets.shades_grey
    );

    return {
        bar: progress,
        start(total: number) {
            progress.start(total, 0, { spin: getSpinner(spinner) });
            timer = setInterval(() => {
                spinner += 1;
                progress.update(current, { spin: getSpinner(spinner) });
            }, 200);
        },
        update(v: number) {
            current = v;
            progress.update(v, { spin: getSpinner(spinner) });
        },
        stop() {
            clearInterval(timer);
            progress.stop();
        },
    };
}

const aspectRatio = 16 / 9;
const defaultWidth = 980;
const defaultHeight = Math.round(980 / aspectRatio);

export async function exportSlides({
    port = 18724,
    range,
    format = "pdf",
    output = "dist/slides",
    meta,
    base = "/",
    timeout = 30000,
    wait = 0,
    dark = false,
    routerMode = "history",
    width = defaultWidth,
    height = defaultHeight,
    withClicks = false,
    executablePath = undefined,
    scale = 1,
    waitUntil,
    omitBackground = false,
}: ExportOptions) {
    const { chromium } = await import("playwright-chromium");
    const browser = await chromium.launch({
        executablePath,
    });
    const context = await browser.newContext({
        viewport: {
            width,
            // Calculate height for every slides to be in the viewport to trigger the rendering of iframes (twitter, youtube...)
            height,
        },
        deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    const progress = createSlidevProgress(true);

    async function go(no: number | string, clicks?: string) {
        const query = new URLSearchParams();
        if (withClicks) query.set("print", "clicks");
        else query.set("print", "true");
        if (range) query.set("range", range);
        if (clicks) query.set("clicks", clicks);

        const url =
            routerMode === "hash"
                ? `http://localhost:${port}${base}?${query}#${no}`
                : `http://localhost:${port}${base}${no}?${query}`;
        await page.goto(url, {
            waitUntil,
            timeout,
        });
        if (waitUntil) await page.waitForLoadState(waitUntil);
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light", media: "screen" });
        const slide = no === "print" ? page.locator("body") : page.locator(`[data-slidev-no="${no}"]`);
        await slide.waitFor();

        // Wait for slides to be loaded
        {
            const elements = slide.locator(".slidev-slide-loading");
            const count = await elements.count();
            for (let index = 0; index < count; index++) await elements.nth(index).waitFor({ state: "detached" });
        }
        // Check for "data-waitfor" attribute and wait for given element to be loaded
        {
            const elements = slide.locator("[data-waitfor]");
            const count = await elements.count();
            for (let index = 0; index < count; index++) {
                const element = elements.nth(index);
                const attribute = await element.getAttribute("data-waitfor");
                if (attribute) {
                    await element
                        .locator(attribute)
                        .waitFor({ state: "visible" })
                        .catch((e) => {
                            console.error(e);
                            process.exitCode = 1;
                        });
                }
            }
        }
        // Wait for frames to load
        {
            const frames = page.frames();
            await Promise.all(frames.map((frame) => frame.waitForLoadState()));
        }
        // Wait for Mermaid graphs to be rendered
        {
            const container = slide.locator("#mermaid-rendering-container");
            const count = await container.count();
            if (count > 0) {
                while (true) {
                    const element = container.locator("div").first();
                    if ((await element.count()) === 0) break;
                    await element.waitFor({ state: "detached" });
                }
                await container.evaluate((node) => (node.style.display = "none"));
            }
        }
        // Hide Monaco aria container
        {
            const elements = slide.locator(".monaco-aria-container");
            const count = await elements.count();
            for (let index = 0; index < count; index++) {
                const element = elements.nth(index);
                await element.evaluate((node) => (node.style.display = "none"));
            }
        }
        // Wait for the given time
        if (wait) await page.waitForTimeout(wait);
    }

    async function genPagePdfOnePiece() {
        await go("print");
        await page.pdf({
            path: output,
            width,
            height,
            margin: {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            printBackground: true,
            preferCSSPageSize: true,
        });

        // Edit generated PDF: add metadata and (optionally) TOC
        let pdfData = await fs.readFile(output);
        let pdf = await PDFDocument.load(pdfData);

        addPdfMetadata(pdf);

        pdfData = Buffer.from(await pdf.save());
        await fs.writeFile(output, pdfData);
    }

    async function genPagePngOnePiece(writeToDisk: boolean) {
        const result: ExportPngResult[] = [];
        await go("print");
        await fs.emptyDir(output);
        const slideContainers = page.locator(".print-slide-container");
        const count = await slideContainers.count();
        for (let i = 0; i < count; i++) {
            progress.update(i + 1);
            const id = (await slideContainers.nth(i).getAttribute("id")) || "";
            const slideNo = +id.split("-")[0];
            const buffer = await slideContainers.nth(i).screenshot({
                omitBackground,
            });
            result.push({ slideIndex: slideNo - 1, buffer });
            if (writeToDisk) await fs.writeFile(path.join(output, `${withClicks ? id : slideNo}.png`), buffer);
        }
        return result;
    }

    function genPagePdf() {
        if (!output.endsWith(".pdf")) output = `${output}.pdf`;
        return genPagePdfOnePiece();
    }

    function genPagePng(writeToDisk = true) {
        return genPagePngOnePiece(writeToDisk);
    }

    // Ported from https://github.com/marp-team/marp-cli/blob/main/src/converter.ts
    async function genPagePptx(pngs: ExportPngResult[]) {
        const { default: PptxGenJS } = await import("pptxgenjs");
        const pptx = new PptxGenJS();

        const layoutName = `${width}x${height}`;
        pptx.defineLayout({
            name: layoutName,
            width: width / 96,
            height: height / 96,
        });
        pptx.layout = layoutName;

        pptx.author = meta?.author ?? "ASI";
        pptx.company = "ASI";
        if (meta?.title) pptx.title = meta.title;
        if (meta?.info) pptx.subject = meta.info;

        pngs.forEach(({ buffer }) => {
            const slide = pptx.addSlide();
            slide.background = {
                data: `data:image/png;base64,${buffer.toString("base64")}`,
            };
        });

        const buffer = (await pptx.write({
            outputType: "nodebuffer",
        })) as Buffer;
        if (!output.endsWith(".pptx")) output = `${output}.pptx`;
        await fs.writeFile(output, buffer);
    }
    // Adds metadata (title, author, keywords) to PDF document, mutating it
    function addPdfMetadata(pdf: PDFDocument): void {
        if (meta?.title) pdf.setTitle(meta.title);
        if (meta?.info) pdf.setSubject(meta.info);
        if (meta?.author) pdf.setAuthor(meta.author);
        if (meta?.keywords) {
            if (Array.isArray(meta?.keywords)) pdf.setKeywords(meta?.keywords);
            else pdf.setKeywords(meta?.keywords.split(","));
        }
    }

    progress.start(10); // "10" used to be the count of pages, doesn't seem to affect anything

    if (format === "pdf") {
        await genPagePdf();
    } else if (format === "png") {
        await genPagePng();
    } else if (format === "pptx") {
        const buffers = await genPagePng(false);
        await genPagePptx(buffers);
    } else {
        throw new Error(`Unsupported exporting format "${format}"`);
    }

    progress.stop();
    browser.close();
    return output;
}
