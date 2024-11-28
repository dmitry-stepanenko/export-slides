import { objectPick } from "@antfu/utils";
import { exportSlides } from "./export";
import yargs from "yargs";

const args = await yargs(process.argv).argv;
const filteredArgs = Object.fromEntries(Object.entries(args).filter(([key]) => ["port", "format", "output", "dark"].includes(key)));

await exportSlides({
    total: 5, // TODO: remove?
    waitUntil: "networkidle",
    port: 4200,
    scale: 2,
    ...filteredArgs,
});
