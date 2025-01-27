import { MetadataCache, TFile, Vault, Notice, getLinkpath } from "obsidian";
import DigitalGardenSettings from "DigitalGardenSettings";
import { Base64 } from "js-base64";
import { Octokit } from "@octokit/core";
import { arrayBufferToBase64, generateUrlPath } from "utils";
import { vallidatePublishFrontmatter } from "Validator";
import { excaliDrawBundle, excalidraw } from "./constants";


export interface IPublisher {
    publish(file: TFile): Promise<boolean>;
    delete(vaultFilePath: string): Promise<boolean>;
    getFilesMarkedForPublishing(): Promise<TFile[]>;
    generateMarkdown(file: TFile): Promise<string>;
}
export default class Publisher {
    vault: Vault;
    metadataCache: MetadataCache;
    settings: DigitalGardenSettings;
    frontmatterRegex = /^\s*?---\n([\s\S]*?)\n---/g;

    constructor(vault: Vault, metadataCache: MetadataCache, settings: DigitalGardenSettings) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
    }

    async getFilesMarkedForPublishing(): Promise<TFile[]> {
        const files = this.vault.getMarkdownFiles();
        const filesToPublish = [];
        for (const file of files) {
            try {
                const frontMatter = this.metadataCache.getCache(file.path).frontmatter
                if (frontMatter && frontMatter["dg-publish"] === true) {
                    filesToPublish.push(file);
                }
            } catch {
                //ignore
            }
        }

        return filesToPublish;
    }

    async delete(vaultFilePath: string): Promise<boolean> {
        if (!this.settings.githubRepo) {
            new Notice("Config error: You need to define a GitHub repo in the plugin settings");
            throw {};
        }
        if (!this.settings.githubUserName) {
            new Notice("Config error: You need to define a GitHub Username in the plugin settings");
            throw {};
        }
        if (!this.settings.githubToken) {
            new Notice("Config error: You need to define a GitHub Token in the plugin settings");
            throw {};
        }

        const octokit = new Octokit({ auth: this.settings.githubToken }); 
        const path = `src/site/notes/${vaultFilePath}`;

        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Delete note ${vaultFilePath}`,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            if (response.status === 200 && response.data.type === "file") {
                payload.sha = response.data.sha;
            }
        } catch (e) {
            console.log(e)
            return false;
        }

        

        try {
            const response = await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', payload);
        } catch (e) {
            console.log(e)
            return false
        }
        return true;
    }


    async publish(file: TFile): Promise<boolean> {
        if (!vallidatePublishFrontmatter(this.metadataCache.getCache(file.path).frontmatter)) {
            return false;
        }
        try {
            const text = await this.generateMarkdown(file);
            await this.uploadText(file.path, text);
            return true;
        } catch {
            return false;
        }
    }

    async generateMarkdown(file: TFile): Promise<string> {
        let text = await this.vault.cachedRead(file);
        text = await this.convertFrontMatter(text, file.path);
        text = await this.createTranscludedText(text, file.path);
        text = await this.convertLinksToFullPath(text, file.path);
        text = await this.createBase64Images(text, file.path);
        return text;

    }


    async uploadText(filePath: string, content: string) {
        if (!this.settings.githubRepo) {
            new Notice("Config error: You need to define a GitHub repo in the plugin settings");
            throw {};
        }
        if (!this.settings.githubUserName) {
            new Notice("Config error: You need to define a GitHub Username in the plugin settings");
            throw {};
        }
        if (!this.settings.githubToken) {
            new Notice("Config error: You need to define a GitHub Token in the plugin settings");
            throw {};
        }


        const octokit = new Octokit({ auth: this.settings.githubToken });


        const base64Content = Base64.encode(content);
        const path = `src/site/notes/${filePath}`

        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Add note ${filePath}`,
            content: base64Content,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            if (response.status === 200 && response.data.type === "file") {
                payload.sha = response.data.sha;
            }
        } catch (e) {
            console.log(e)
        }

        payload.message = `Update note ${filePath}`;

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', payload);

    }

    async convertFrontMatter(text: string, path: string): Promise<string> {
        const cachedFrontMatter = this.metadataCache.getCache(path).frontmatter;
        const frontMatter = { ...cachedFrontMatter };

        const publishedFrontMatter:any = {"dg-publish":true};

        if (frontMatter && frontMatter["dg-permalink"]) {
            publishedFrontMatter["dg-permalink"] = frontMatter["dg-permalink"];
            publishedFrontMatter["permalink"] = frontMatter["dg-permalink"];
            if (!publishedFrontMatter["permalink"].endsWith("/")) {
                publishedFrontMatter["permalink"] += "/";
            }
            if (!publishedFrontMatter["permalink"].startsWith("/")) {
                publishedFrontMatter["permalink"] = "/" + publishedFrontMatter["permalink"];
            }
        } else {
            const noteUrlPath = generateUrlPath(path);
            publishedFrontMatter["permalink"] = "/" + noteUrlPath;
        }

        if (frontMatter && frontMatter["dg-home"]) {
            const tags = frontMatter["tags"];
            if (tags) {
                if (typeof (tags) === "string") {
                    publishedFrontMatter["tags"] = [tags, "gardenEntry"];
                } else {
                    publishedFrontMatter["tags"] = [...tags, "gardenEntry"];
                }
            } else {
                publishedFrontMatter["tags"] = "gardenEntry";
            }

        }

        if(frontMatter && frontMatter["dg-home-link"] === false){
            publishedFrontMatter["dgHomeLink"] = false;
        }

        //replace frontmatter at start of file

        const replaced = text.replace(this.frontmatterRegex, (match, p1) => {
            const frontMatterString = JSON.stringify(publishedFrontMatter);
            return `---\n${frontMatterString}\n---`;
        });
        return replaced;
    }

    async convertLinksToFullPath(text: string, filePath: string): Promise<string> {
        let convertedText = text;
        const links = this.metadataCache.getCache(filePath).links;
        if (links && links.length) {
            for (const link of links) {
                try {
                    const textInsideBrackets =link.original.substring(link.original.indexOf('[') + 2,link.original.indexOf(']'));
                    let [linkedFileName, prettyName] = textInsideBrackets.split("|");

                    prettyName = prettyName || linkedFileName;
                    let headerPath = "";
                    if (linkedFileName.includes("#")) {
                        const headerSplit = linkedFileName.split("#");
                        linkedFileName = headerSplit[0];
                        //currently no support for linking to nested heading with multiple #s
                        headerPath = headerSplit.length > 1 ? `#${headerSplit[1]}` : '';
                        
                    }
                    const fullLinkedFilePath = getLinkpath(linkedFileName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(fullLinkedFilePath, filePath);

                    if (linkedFile.extension === "md") {
                        const extensionlessPath = linkedFile.path.substring(0, linkedFile.path.lastIndexOf('.'));
                        convertedText = convertedText.replace(link.original, `[[${extensionlessPath}${headerPath}|${prettyName}]]`);
                    }
                } catch {
                    continue;
                }
            }
        }

        return convertedText;

    }

    async createTranscludedText(text: string, filePath: string): Promise<string> {
        let transcludedText = text;
        const transcludedRegex = /!\[\[(.*?)\]\]/g;
        const transclusionMatches = text.match(transcludedRegex);
        let numberOfExcaliDraws = 0;
        if (transclusionMatches) {
            for (let i = 0; i < transclusionMatches.length; i++) {
                try {
                    const transclusionMatch = transclusionMatches[i];
                    let [tranclusionFileName, headerName] = transclusionMatch.substring(transclusionMatch.indexOf('[') + 2, transclusionMatch.indexOf(']')).split("|");
                    const tranclusionFilePath = getLinkpath(tranclusionFileName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(tranclusionFilePath, filePath);

                    if (linkedFile.name.endsWith(".excalidraw.md")) {
                        let fileText = await this.vault.cachedRead(linkedFile);
                        const start = fileText.indexOf('```json') + "```json".length;
                        const end = fileText.lastIndexOf('```')
                        const excaliDrawJson = JSON.parse(fileText.slice(start, end));

                        const drawingId = linkedFile.name.split(" ").join("_").replace(".", "") + numberOfExcaliDraws;
                        let excaliDrawCode = "";
                        if(++numberOfExcaliDraws === 1){
                            excaliDrawCode += excaliDrawBundle;
                        }

                        excaliDrawCode += excalidraw(JSON.stringify(excaliDrawJson), drawingId);

                        transcludedText = transcludedText.replace(transclusionMatch, excaliDrawCode);

                    }else if (linkedFile.extension === "md") {

                        let fileText = await this.vault.cachedRead(linkedFile);

                        //Remove frontmatter from transclusion
                        fileText = fileText.replace(this.frontmatterRegex, "");

                        const header = this.generateTransclusionHeader(headerName, linkedFile);

                        const headerSection = header ? `${header}\n` : '';

                        fileText = `\n<div class="transclusion internal-embed is-loaded"><div class="markdown-embed">\n\n<div class="markdown-embed-title">\n\n${headerSection}\n\n</div>\n\n` 
                            + fileText + '\n\n</div></div>\n'
                        //This should be recursive up to a certain depth
                        transcludedText = transcludedText.replace(transclusionMatch, fileText);
                    }
                } catch {
                    continue;
                }
            }
        }

        return transcludedText;

    }

    async createBase64Images(text: string, filePath: string): Promise<string> {
        let imageText = text;
        const imageRegex = /!\[\[(.*?)(\.(png|jpg|jpeg|gif))\|(.*?)\]\]|!\[\[(.*?)(\.(png|jpg|jpeg|gif))\]\]/g;
        const imageMatches = text.match(imageRegex);
        if (imageMatches) {
            for (let i = 0; i < imageMatches.length; i++) {
                try {
                    const imageMatch = imageMatches[i];

                    let [imageName, size] = imageMatch.substring(imageMatch.indexOf('[') + 2, imageMatch.indexOf(']')).split("|");
                    const imagePath = getLinkpath(imageName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const image = await this.vault.readBinary(linkedFile);
                    const imageBase64 = arrayBufferToBase64(image)
                    const name = size ? `${imageName}|${size}` : imageName;
                    const imageMarkdown = `![${name}](data:image/${linkedFile.extension};base64,${imageBase64})`;
                    imageText = imageText.replace(imageMatch, imageMarkdown);
                } catch {
                    continue;
                }
            }
        }

        return imageText;
    }

    generateTransclusionHeader(headerName: string, transcludedFile: TFile) {
        if (!headerName) {
            return headerName;
        }

        const titleVariable = "{{title}}";
        if (headerName && headerName.indexOf(titleVariable) > -1) {
            headerName = headerName.replace(titleVariable, transcludedFile.basename);
        }

        //Defaults to h1
        if (headerName && !headerName.startsWith("#")) {
            headerName = "# " + headerName;
        } else if (headerName) {
            //Add a space to the start of the header if not already there
            const headerParts = headerName.split("#");
            if (!headerParts.last().startsWith(" ")) {
                headerName = headerName.replace(headerParts.last(), " " + headerParts.last());
            }

        }
        return headerName;
    }
}



