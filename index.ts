import { exportSlides } from "./export";
import yargs from "yargs";

const args = yargs(process.argv).argv;

const filteredArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => ["port", "format", "output", "dark"].includes(key))
);

await exportSlides({
    waitUntil: "networkidle",
    port: 4200,
    scale: 2,
    ...filteredArgs,
});
