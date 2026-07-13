# Installing Case File

The install flow below is the target user experience for the first field test.

## What the User Receives

- `case-file.mcpb`
- A short note saying they need a Gemini API key
- No terminal commands
- No account or token required

## Claude Desktop Install Flow

1. Download `case-file.mcpb`.
2. Open Claude Desktop.
3. Install the bundle using one of these paths:
   - double-click the `.mcpb` file;
   - drag the `.mcpb` file into Claude Desktop;
   - open Settings > Extensions > Advanced settings > Install Extension.
4. When prompted, choose the local folder where case files may live.
5. Paste the Gemini API key when prompted.
6. Keep the default OCR settings unless testing a very large process.

## First Use

1. Put the case PDF inside the authorized local folder.
2. Ask Claude to create a local case from that PDF.
3. Ask for `status_caso` until ingestion finishes or reports pending OCR.
4. If OCR is pending, approve a bounded run with `autorizar_ocr`.
5. Ask for `analisar_caso_civel` or `montar_pacote_evidencias`.

## Data Boundary

Case files stay in the selected local folder. OCR calls send page images/text to Gemini using the user's own key. Jurisprudence research is handled by whichever separate jurisprudence MCP the user already has connected.
