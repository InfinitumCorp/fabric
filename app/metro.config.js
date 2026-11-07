// Lets the app import the shared platform-free rules in ../core.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../core/src')];
module.exports = config;
