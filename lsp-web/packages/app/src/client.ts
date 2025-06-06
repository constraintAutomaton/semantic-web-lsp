import * as jsrpc from "json-rpc-2.0";
import * as monaco from "monaco-editor-core";
import { JSONRPCRequest } from "json-rpc-2.0";
import {
    AbstractMessageReader,
    AbstractMessageWriter,
    DataCallback,
    Disposable,
    MessageWriter,
} from "vscode-jsonrpc";
import * as proto from "vscode-languageserver-protocol";
import { MessageReader, RequestMessage } from "vscode-languageserver-protocol";

import { Codec, FromServer, IntoServer } from "common";
import {
    MonacoToProtocolConverter,
    ProtocolToMonacoConverter,
} from "monaco-languageclient";

export const monacoToProtocol = new MonacoToProtocolConverter(monaco);
export const protocolToMonaco = new ProtocolToMonacoConverter(monaco);

class Reader extends AbstractMessageReader {
    private callBacks: DataCallback[] = [];
    private fromServer: FromServer;

    constructor(fromServer: FromServer) {
        super();
        this.fromServer = fromServer;
    }

    async init(): Promise<void> {
        for await (const request of this.fromServer.requests) {
            for (let cb of this.callBacks) {
                cb(request);
            }
        }
    }

    listen(callback: DataCallback): Disposable {
        this.callBacks.push(callback);
        return {
            dispose() { },
        };
    }
}

class Writer extends AbstractMessageWriter {
    intoServer: IntoServer;
    fromServer: FromServer;
    constructor(intoServer: IntoServer, fromServer: FromServer) {
        super();
        this.intoServer = intoServer;
        this.fromServer = fromServer;
    }

    async write(msg: RequestMessage) {
        const encoded = Codec.encode(<JSONRPCRequest>msg);
        this.intoServer.enqueue(encoded);

        if (null != msg.id) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const response = await this.fromServer.responses.get(msg.id)!;
        }
    }

    end(): void { }
}

export class NewClient {
    #fromServer: FromServer;
    #intoServer: IntoServer;
    constructor(fromServer: FromServer, intoServer: IntoServer) {
        this.#intoServer = intoServer;
        this.#fromServer = fromServer;
    }

    reader(): MessageReader {
        return new Reader(this.#fromServer);
    }

    writer(): MessageWriter {
        return new Writer(this.#intoServer, this.#fromServer);
    }
}

export default class Client extends jsrpc.JSONRPCServerAndClient {
    afterInitializedHooks: (() => Promise<void>)[] = [];
    #fromServer: FromServer;

    languages: Set<string> = new Set();
    legend: monaco.languages.SemanticTokensLegend = {
        tokenTypes: [],
        tokenModifiers: [],
    };

    editors: { [id: string]: monaco.editor.IModel } = {};

    constructor(fromServer: FromServer, intoServer: IntoServer) {
        super(
            new jsrpc.JSONRPCServer(),
            new jsrpc.JSONRPCClient(async (json: jsrpc.JSONRPCRequest) => {
                const encoded = Codec.encode(json);
                intoServer.enqueue(encoded);
                if (null != json.id) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const response = await fromServer.responses.get(json.id)!;
                    this.client.receive(response as jsrpc.JSONRPCResponse);
                }
            })
        );

        this.#fromServer = fromServer;
    }

    setEditor(editor: monaco.editor.IModel, uri: string) {
        this.editors[uri] = editor;
    }

    addLanguage(language: monaco.languages.ILanguageExtensionPoint): string {
        if (!this.languages.has(language.id)) {
            this.languages.add(language.id);
            const client = this;
            monaco.languages.register(language);
            monaco.languages.registerDocumentSymbolProvider(language.id, {
                // eslint-disable-next-line
                async provideDocumentSymbols(
                    model,
                    token
                ): Promise<monaco.languages.DocumentSymbol[]> {
                    void token;
                    const response = await (client.request(
                        proto.DocumentSymbolRequest.type.method,
                        {
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                        } as proto.DocumentSymbolParams
                    ) as Promise<proto.SymbolInformation[]>);

                    const uri = model.uri.toString();

                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    const result: monaco.languages.DocumentSymbol[] =
                        protocolToMonaco.asSymbolInformations(response, uri);

                    return result;
                },
            });

            monaco.languages.registerDocumentFormattingEditProvider(language.id, {
                async provideDocumentFormattingEdits(model, options, _token) {
                    const response = await client.request(
                        proto.DocumentFormattingRequest.type.method,
                        {
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                            options: monacoToProtocol.asFormattingOptions(options),
                        } as proto.DocumentFormattingParams
                    );

                    return protocolToMonaco.asTextEdits(response || []);
                },
            });

            monaco.languages.registerRenameProvider(language.id, {
                async provideRenameEdits(model, position, newName, _token) {
                    const response = await client.request(
                        proto.RenameRequest.type.method,
                        {
                            newName,
                            position: monacoToProtocol.asPosition(
                                position.lineNumber,
                                position.column
                            ),
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                        } as proto.RenameParams
                    );

                    return protocolToMonaco.asWorkspaceEdit(response);
                },

                async resolveRenameLocation(model, position, _token) {

                    const response = await client.request(
                        proto.PrepareRenameRequest.type.method,
                        {
                            position: monacoToProtocol.asPosition(
                                position.lineNumber,
                                position.column
                            ),
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                        } as proto.PrepareRenameParams
                    );

                    if (response) {
                        return {
                            text: response.placeholder,
                            range: protocolToMonaco.asRange(<proto.Range>response.range),
                        };
                    } else {
                        return {
                            rejectReason: "No valid token to rename",
                            text: "",
                            range: {
                                startColumn: 0,
                                endColumn: 0,
                                startLineNumber: 0,
                                endLineNumber: 0,
                            },
                        };
                    }
                },
            });

            monaco.languages.registerHoverProvider(language.id, {
                async provideHover(model, position, _token) {
                    const response = await client.request(
                        proto.HoverRequest.type.method,
                        {
                            position: monacoToProtocol.asPosition(
                                position.lineNumber,
                                position.column
                            ),
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                        } as proto.HoverParams
                    );

                    return protocolToMonaco.asHover(response);
                },
            });

            monaco.languages.registerCompletionItemProvider(language.id, {
                async provideCompletionItems(model, position, _token, _context) {
                    const response = await client.request(
                        proto.CompletionRequest.type.method,
                        {
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                            position: monacoToProtocol.asPosition(
                                position.lineNumber,
                                position.column
                            ),
                        } as proto.CompletionParams
                    );
                    let out = {
                        incomplete: false,
                        suggestions: [],
                    };

                    try {
                        out = protocolToMonaco.asCompletionResult(
                            {
                                isIncomplete: false,
                                items: response,
                            },
                            {
                                startLineNumber: 1,
                                startColumn: 1,
                                endLineNumber: 1,
                                endColumn: 1,
                            }
                        );
                    } catch (ex: any) {
                        console.log(ex);
                    }

                    return out;
                },
            });

            monaco.languages.registerDocumentSemanticTokensProvider(language.id, {
                releaseDocumentSemanticTokens() { },
                getLegend(): monaco.languages.SemanticTokensLegend {
                    return client.legend;
                },
                async provideDocumentSemanticTokens(model) {
                    const response = await client.request(
                        proto.SemanticTokensRequest.type.method,
                        {
                            textDocument: monacoToProtocol.asTextDocumentIdentifier(model),
                        } as proto.SemanticTokensParams
                    );
                    return protocolToMonaco.asSemanticTokens(response);
                },
            });
        } else {
            console.error("Language already added", language.id);
        }
        return language.id;
    }

    private handleDiagnostics(diagnostics: proto.PublishDiagnosticsParams) {

        const url = diagnostics.uri;
        const model = this.editors[url];

        if (model) {
            monaco.editor.setModelMarkers(
                model,
                "SWLS",
                protocolToMonaco.asDiagnostics(diagnostics.diagnostics)
            );
        }
    }

    async start(): Promise<void> {
        this.addMethod(
            proto.PublishDiagnosticsNotification.type.method,
            (params) => {
                this.handleDiagnostics(params);
                // onDiagnostic(params);
            }
        );

        this.addMethod("custom/readFile", (alpha, beta) => {
            console.log("custom/readFile", { alpha, beta })
            return {
                error: "Not implemented"
            }
        });

        // request "initialize": client <-> server
        const resp: any = await (this.request(proto.InitializeRequest.type.method, {
            processId: null,
            clientInfo: {
                name: "demo-language-client",
            },
            capabilities: {
                textDocument: {
                    publishDiagnostics: {},
                },
            },
            rootUri: null,
        } as proto.InitializeParams) as Promise<jsrpc.JSONRPCResponse>);

        this.legend = resp.capabilities.semanticTokensProvider.legend;

        // notify "initialized": client --> server
        this.notify(proto.InitializedNotification.type.method, {});

        await Promise.all(
            this.afterInitializedHooks.map((f: () => Promise<void>) => f())
        );
        await Promise.all([this.processNotifications(), this.processRequests()]);
    }


    async processNotifications(): Promise<void> {
        for await (const notification of this.#fromServer.notifications) {
            console.log(notification);
            await this.receiveAndSend(notification);
        }
    }

    async processRequests(): Promise<void> {
        for await (const request of this.#fromServer.requests) {
            console.log(request);
            await this.receiveAndSend(request);
        }
    }

    pushAfterInitializeHook(...hooks: (() => Promise<void>)[]): void {
        this.afterInitializedHooks.push(...hooks);
    }
}
