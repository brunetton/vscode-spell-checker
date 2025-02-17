import { setOfSupportedSchemes, supportedSchemes } from 'common-utils/uriHelper.js';
import { WorkspaceConfigForDocument } from 'server/api';
import {
    CodeAction,
    CodeActionKind,
    Command,
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Disposable,
    ExtensionContext,
    languages as vsCodeSupportedLanguages,
    Position,
    Range,
    TextDocument,
    Uri,
    workspace,
} from 'vscode';
import * as VSCodeLangClient from 'vscode-languageclient/node';
import { ForkOptions, LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { diagnosticSource } from '../constants';
import * as Settings from '../settings';
import { Inspect, inspectConfigKeys, sectionCSpell } from '../settings';
import * as LanguageIds from '../settings/languageIds';
import { Maybe } from '../util';
import { createBroadcaster } from '../util/broadcaster';
import { findConicalDocumentScope } from '../util/documentUri';
import { logErrors, silenceErrors } from '../util/errors';
import { Resolvable } from './Resolvable';
import {
    createServerApi,
    FieldExistsInTarget,
    GetConfigurationForDocumentResult,
    IsSpellCheckEnabledResult,
    OnSpellCheckDocumentStep,
    requestCodeAction,
    ServerApi,
    WorkspaceConfigForDocumentRequest,
    WorkspaceConfigForDocumentResponse,
} from './server';

// The debug options for the server
const debugExecArgv = ['--nolazy', '--inspect=60048'];

const diagnosticCollectionName = diagnosticSource;

export interface ServerResponseIsSpellCheckEnabled extends Partial<IsSpellCheckEnabledResult> {}

export interface ServerResponseIsSpellCheckEnabledForFile extends ServerResponseIsSpellCheckEnabled {
    uri: Uri;
}

interface TextDocumentInfo {
    uri?: Uri;
    languageId?: string;
}

export class CSpellClient implements Disposable {
    readonly client: LanguageClient;
    readonly import: Set<string> = new Set();
    readonly languageIds: Set<string>;
    readonly allowedSchemas: Set<string>;

    private serverApi: ServerApi;
    private disposables: Set<Disposable> = new Set();
    private broadcasterOnSpellCheckDocument = createBroadcaster<OnSpellCheckDocumentStep>();
    private ready: Resolvable<void> = new Resolvable();

    /**
     * @param: {string} module -- absolute path to the server module.
     */
    constructor(context: ExtensionContext, languageIds: string[]) {
        // The server is implemented in node
        const module = context.asAbsolutePath('packages/_server/dist/main.js');

        const enabledLanguageIds = Settings.getScopedSettingFromVSConfig('enabledLanguageIds', Settings.Scopes.Workspace);
        this.allowedSchemas = new Set(
            Settings.getScopedSettingFromVSConfig('allowedSchemas', Settings.Scopes.Workspace) || supportedSchemes
        );
        setOfSupportedSchemes.clear();
        this.allowedSchemas.forEach((schema) => setOfSupportedSchemes.add(schema));

        this.languageIds = new Set(languageIds.concat(enabledLanguageIds || []).concat(LanguageIds.languageIds));
        const uniqueLangIds = [...this.languageIds];
        const documentSelector = [...this.allowedSchemas]
            .map((scheme) => uniqueLangIds.map((language) => ({ language, scheme })))
            .reduce((a, b) => a.concat(b));
        // Options to control the language client
        const clientOptions: LanguageClientOptions = {
            documentSelector,
            diagnosticCollectionName,
            synchronize: {
                // Synchronize the setting section 'spellChecker' to the server
                configurationSection: [sectionCSpell, 'search'],
            },
            middleware: {
                handleDiagnostics(uri, diagnostics, next) {
                    // console.error(`${new Date().toISOString()} Client handleDiagnostics: ${uri.toString()}`);
                    next(uri, diagnostics);
                },
            },
        };

        const execArgv = this.calcServerArgs();
        const options: ForkOptions = { execArgv };
        // The debug options for the server
        const debugOptions: ForkOptions = { execArgv: [...execArgv, ...debugExecArgv] };

        // If the extension is launched in debug mode the debug server options are use
        // Otherwise the run options are used
        const serverOptions: ServerOptions = {
            run: { module, transport: TransportKind.ipc, options },
            debug: { module, transport: TransportKind.ipc, options: debugOptions },
        };

        // Create the language client and start the client.
        this.client = new LanguageClient('cspell', 'Code Spell Checker', serverOptions, clientOptions);
        this.client.registerProposedFeatures();
        this.serverApi = createServerApi(this.client);
        this.initWhenReady();
    }

    public start(): Promise<void> {
        if (this.ready.isPending()) {
            this.ready.resolve(this.client.start());
        }
        return this.ready.promise;
    }

    public async isSpellCheckEnabled(document: TextDocument): Promise<ServerResponseIsSpellCheckEnabledForFile> {
        const { uri, languageId = '' } = document;

        if (!uri || !languageId) {
            return { uri };
        }
        const response = await this.serverApi.isSpellCheckEnabled({ uri: uri.toString(), languageId });
        return { ...response, uri };
    }

    readonly getConfigurationForDocument = this.factoryGetConfigurationForDocument();

    private async _getConfigurationForDocument(
        document: TextDocument | TextDocumentInfo | undefined
    ): Promise<GetConfigurationForDocumentResult> {
        const { uri, languageId } = document || {};

        const workspaceConfig = calculateWorkspaceConfigForDocument(uri);
        if (!uri) {
            return this.serverApi.getConfigurationForDocument({ workspaceConfig });
        }
        return this.serverApi.getConfigurationForDocument({ uri: uri.toString(), languageId, workspaceConfig });
    }

    private cacheGetConfigurationForDocument = new Map<string | undefined, Promise<GetConfigurationForDocumentResult>>();

    private factoryGetConfigurationForDocument(): (
        document: TextDocument | TextDocumentInfo | undefined
    ) => Promise<GetConfigurationForDocumentResult> {
        return (document: TextDocument | TextDocumentInfo | undefined) => {
            const key = document?.uri?.toString();
            const found = this.cacheGetConfigurationForDocument.get(key);
            if (found) return found;
            const result = this._getConfigurationForDocument(document);
            this.cacheGetConfigurationForDocument.set(key, result);
            return result;
        };
    }

    public notifySettingsChanged(): Promise<void> {
        this.cacheGetConfigurationForDocument.clear();
        setTimeout(() => this.cacheGetConfigurationForDocument.clear(), 250);
        return silenceErrors(
            this.whenReady(() => this.serverApi.notifyConfigChange()),
            'notifySettingsChanged'
        );
    }

    public registerConfiguration(path: string): Promise<void> {
        return logErrors(
            this.whenReady(() => this.serverApi.registerConfigurationFile(path)),
            'registerConfiguration'
        );
    }

    get diagnostics(): Maybe<DiagnosticCollection> {
        return (this.client && this.client.diagnostics) || undefined;
    }

    public triggerSettingsRefresh(): Promise<void> {
        return this.notifySettingsChanged();
    }

    public async whenReady<R>(fn: () => R): Promise<R> {
        await this.onReady();
        return fn();
    }

    private onReady(): Promise<void> {
        return this.ready.promise;
    }

    public static create(context: ExtensionContext): Promise<CSpellClient> {
        return Promise.resolve(vsCodeSupportedLanguages.getLanguages().then((langIds) => new CSpellClient(context, langIds)));
    }

    private registerDisposable(...disposables: Disposable[]) {
        for (const d of disposables) {
            this.disposables.add(d);
        }
    }

    public dispose(): void {
        this.client.stop();
        const toDispose = [...this.disposables];
        this.disposables.clear();
        Disposable.from(...toDispose).dispose();
    }

    private calcServerArgs(): string[] {
        const args: string[] = [];
        return args;
    }

    public onSpellCheckDocumentNotification(fn: (p: OnSpellCheckDocumentStep) => void): Disposable {
        return this.broadcasterOnSpellCheckDocument.listen(fn);
    }

    public async requestSpellingSuggestions(doc: TextDocument, range: Range, diagnostics: Diagnostic[]): Promise<CodeAction[]> {
        const params: VSCodeLangClient.CodeActionParams = {
            textDocument: VSCodeLangClient.TextDocumentIdentifier.create(doc.uri.toString()),
            range: mapRangeToLangClient(range),
            context: VSCodeLangClient.CodeActionContext.create(diagnostics.map(mapDiagnosticToLangClient)),
        };
        const r = await requestCodeAction(this.client, params);
        if (!r) return [];

        const actions = r.filter(isCodeAction).map(mapCodeAction);
        return actions;
    }

    private async initWhenReady() {
        await this.onReady();
        this.registerHandleNotificationsFromServer();
        this.registerHandleOnWorkspaceConfigForDocumentRequest();
    }

    private registerHandleOnWorkspaceConfigForDocumentRequest() {
        this.registerDisposable(this.serverApi.onWorkspaceConfigForDocumentRequest(handleOnWorkspaceConfigForDocumentRequest));
    }

    private registerHandleNotificationsFromServer() {
        this.registerDisposable(this.serverApi.onSpellCheckDocument((p) => this.broadcasterOnSpellCheckDocument.send(p)));
    }
}

function handleOnWorkspaceConfigForDocumentRequest(req: WorkspaceConfigForDocumentRequest): WorkspaceConfigForDocumentResponse {
    const { uri } = req;
    const docUri = Uri.parse(uri);
    return calculateWorkspaceConfigForDocument(docUri);
}

function calculateWorkspaceConfigForDocument(docUri: Uri | undefined): WorkspaceConfigForDocument {
    const scope = findConicalDocumentScope(docUri);
    const cfg = inspectConfigKeys(scope, ['words', 'userWords', 'ignoreWords']);
    const workspaceFile = workspace.workspaceFile?.toString();
    const workspaceFolder = scope && workspace.getWorkspaceFolder(scope)?.uri.toString();

    const allowFolder = workspaceFile !== undefined;

    const tUserWords = toConfigTarget(cfg.userWords, allowFolder);
    const tWords = toConfigTarget(cfg.words, allowFolder);
    const tIgnoreWords = toConfigTarget(cfg.ignoreWords, allowFolder);

    tWords.user = tUserWords.user;

    const resp: WorkspaceConfigForDocumentResponse = {
        uri: docUri?.toString(),
        workspaceFile,
        workspaceFolder,
        words: tWords,
        ignoreWords: tIgnoreWords,
    };

    // console.log('handleOnWorkspaceConfigForDocumentRequest Req: %o Res: %o cfg: %o', req, resp, cfg);

    return resp;
}

function toConfigTarget<T>(ins: Inspect<T> | undefined, allowFolder: boolean): FieldExistsInTarget {
    if (!ins) return {};
    const { globalValue, workspaceValue, workspaceFolderValue } = ins;
    return {
        user: globalValue !== undefined || undefined,
        workspace: workspaceValue !== undefined || undefined,
        folder: allowFolder && (workspaceFolderValue !== undefined || undefined),
    };
}

function isCodeAction(c: VSCodeLangClient.Command | VSCodeLangClient.CodeAction): c is VSCodeLangClient.CodeAction {
    return VSCodeLangClient.CodeAction.is(c);
}

function mapCodeAction(c: VSCodeLangClient.CodeAction): CodeAction {
    const kind = (c.kind !== undefined && CodeActionKind.Empty.append(c.kind)) || undefined;
    const action = new CodeAction(c.title, kind);
    action.command = c.command && mapCommand(c.command);
    return action;
}

function mapCommand(c: VSCodeLangClient.Command): Command {
    return c;
}

type MapDiagnosticSeverity = {
    [key in DiagnosticSeverity]: VSCodeLangClient.DiagnosticSeverity;
};

const diagSeverityMap: MapDiagnosticSeverity = {
    [DiagnosticSeverity.Error]: VSCodeLangClient.DiagnosticSeverity.Error,
    [DiagnosticSeverity.Warning]: VSCodeLangClient.DiagnosticSeverity.Warning,
    [DiagnosticSeverity.Information]: VSCodeLangClient.DiagnosticSeverity.Information,
    [DiagnosticSeverity.Hint]: VSCodeLangClient.DiagnosticSeverity.Hint,
};

function mapDiagnosticToLangClient(d: Diagnostic): VSCodeLangClient.Diagnostic {
    const diag = VSCodeLangClient.Diagnostic.create(
        mapRangeToLangClient(d.range),
        d.message,
        diagSeverityMap[d.severity],
        undefined,
        d.source
    );
    return diag;
}

function mapRangeToLangClient(r: Range): VSCodeLangClient.Range {
    const { start, end } = r;
    return VSCodeLangClient.Range.create(mapPositionToLangClient(start), mapPositionToLangClient(end));
}

function mapPositionToLangClient(p: Position): VSCodeLangClient.Position {
    const { line, character } = p;
    return VSCodeLangClient.Position.create(line, character);
}
