'use strict';
// Única fuente de verdad: qué partes de la API de VS Code existen en el entorno aislado de CodeIDE.
// El validador la usa para decir si un plugin es compatible; el ejecutor (runner.js) las implementa.
const API_SOPORTADA = {
    window: ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'setStatusBarMessage',
        'createStatusBarItem', 'createOutputChannel', 'activeTextEditor'],
    commands: ['registerCommand', 'executeCommand', 'getCommands'],
    languages: ['registerCompletionItemProvider', 'registerHoverProvider',
        'registerDocumentFormattingEditProvider', 'createDiagnosticCollection'],
    workspace: ['getConfiguration', 'onDidChangeConfiguration', 'onDidChangeTextDocument',
        'onDidOpenTextDocument', 'onDidSaveTextDocument', 'workspaceFolders', 'textDocuments'],
    env: ['appName', 'language', 'machineId', 'sessionId', 'uriScheme'],
    extensions: ['getExtension', 'all'],
};

// Lo que NUNCA existe aquí (necesita ventanas, procesos o disco del usuario)
const API_SIN_SOPORTE_CONOCIDA = ['createWebviewPanel', 'registerWebviewViewProvider', 'createTerminal',
    'registerDebugConfigurationProvider', 'startDebugging', 'createTreeView', 'registerTreeDataProvider',
    'registerCustomEditorProvider', 'createNotebookController'];

module.exports = { API_SOPORTADA, API_SIN_SOPORTE_CONOCIDA };
