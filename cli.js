#!/usr/bin/env node
const yargs = require("yargs");
const relativeDeps = require("./index");

yargs
  .usage("Usage: $0 <command> [options]")
  .command({
    command: "*",
    describe: "Install relative deps",
    handler: relativeDeps.installRelativeDeps
  })
  .command({
    command: "watch",
    describe: "Watch relative deps and install on change",
    handler: relativeDeps.watchRelativeDeps
  })
  .command({
    command: "watch-next",
    describe: "Watch relative deps and install on change, reloading next dev process",
    handler: relativeDeps.watchRelativeDepsWithNext
  })
  .command({
    command: "init",
    describe: "Initialize relative-deps",
    handler: relativeDeps.initRelativeDeps
  })
  .command({
    command: "add [paths...]",
    describe: "Add path as relative dependencies",
    handler: relativeDeps.addRelativeDeps
  })
  .option("D", {
    alias: ["dev", "save-dev"],
    description: "Save as dev dependency",
    default: false,
    type: "boolean"
  })
  .option("S", {
    alias: ["script"],
    description: "Script for relative-deps",
    default: "prepare",
    type: "string"
  }).argv;
