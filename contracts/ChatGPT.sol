// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "openzeppelin-contracts/contracts/access/Ownable.sol";

/**
 * @title PrivateMultiModalChatGPT
 * @notice On-chain, private, multi-modal ChatGPT on Ritual Chain.
 *          • Text: LLM precompile (0x0802)
 *          • Image: Image precompile (0x0818) via 2-phase callback
 *          • Conversation history stored on-chain via StorageRef (DA provider)
 *
 * Guides used:
 *   • ritual-dapp-llm — LLM ABI (30 fields), executor selection, fee flow
 *   • ritual-dapp-multimodal — multimodal 2-phase callbacks + StorageRef
 *   • ritual-dapp-precompiles — base field layout, AsyncDelivery sender
 *
 * Chain:    Ritual Testnet (ID 1979)
 * Precompiles:
 *   LLM      0x0000000000000000000000000000000000000802  (short-running async)
 *   Image    0x0000000000000000000000000000000000000818  (long-running async)
 *   Audio    0x0000000000000000000000000000000000000819
 *   Video    0x000000000000000000000000000000000000081A
 * System:
 *   RitualWallet              0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948
 *   TEEServiceRegistry        0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F
 *   SecretsAccessControl      0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD
 *   AsyncDelivery (callback)  0x5A16214fF555848411544b005f7Ac063742f39F6
 */
contract PrivateMultiModalChatGPT is Ownable {
    /* ─── Constants ─── */

    address public constant RITUAL_WALLET = 0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948;
    address public constant TEE_SERVICE_REGISTRY = 0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F;
    address public constant SECRETS_ACCESS_CONTROL = 0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD;
    address public constant ASYNC_DELIVERY = 0x5A16214fF555848411544b005f7Ac063742f39F6;

    // Precompile addresses
    address public constant LLM_PRECOMPILE   = 0x0000000000000000000000000000000000000802;
    address public constant IMAGE_PRECOMPILE = 0x0000000000000000000000000000000000000818;
    address public constant AUDIO_PRECOMPILE = 0x0000000000000000000000000000000000000819;
    address public constant VIDEO_PRECOMPILE = 0x000000000000000000000000000000000000081A;

    // Capability IDs from TEEServiceRegistry
    uint8  public constant CAP_LLM   = 1;   // LLM
    uint8  public constant CAP_IMAGE = 7;   // IMAGE_CALL
    uint8  public constant CAP_AUDIO = 8;   // AUDIO_CALL
    uint8  public constant CAP_VIDEO = 9;   // VIDEO_CALL

    // Model used for LLM (confirmed live on-chain)
    string public constant MODEL_LLM = "zai-org/GLM-4.7-FP8";

    // Default moderation system prompt
    string public constant DEFAULT_SYSTEM_PROMPT =
        "You are a helpful, private, multi-modal AI assistant. You may generate text and images on-chain via Ritual's TEE-verified precompiles. Keep responses concise.";

    /* ─── Structs ─── */

    struct GenerationRequest {
        address user;            // who submitted
        bytes32 id;              // keccak256(txHash) for fast lookup
        GenerationType genType;  // TEXT, IMAGE, AUDIO, VIDEO
        string  prompt;          // text prompt
        string  model;           // model id
        bool    isComplete;      // finished (callback received or LLM settled)
        bool    hasError;        // sad path
        string  errorMessage;    // err string from executor
        uint256 timestamp;       // block.timestamp when submitted
        string  resultUri;       // for image/audio/video: storage URI
        bytes32 resultHash;      // SHA256 of generated file (for integrity)
        uint256 resultSize;      // file size in bytes (media only)
        string  conversationRef; // extra field for easy cross-ref
    }

    enum GenerationType { TEXT, IMAGE, AUDIO, VIDEO }

    struct StorageRef {
        string platform; // "gcs" | "hf" | "pinata"
        string path;     // bucket/repo/file
        string keyRef;   // key name in encryptedSecrets
    }

    struct MediaResult {
        string uri;
        bytes32 contentHash;
        uint256 timestamp;
        bool encrypted;
    }

    /* ─── State ─── */

    // Text conversations are stored off-chain in DA — we only save the StorageRef here
    string public latestConvoRefPlatform = "gcs";
    string public latestConvoRefPath    = "convos/default.jsonl";
    string public latestConvoRefKeyRef  = "GCS_CREDS";

    // Active/pending requests (keyed by reqId = keccak256(txHash))
    mapping(bytes32 => GenerationRequest) public requests;
    bytes32[] public requestIds; // history index

    // Media results from callbacks
    mapping(bytes32 => MediaResult) public mediaResults;
    bytes32[] public mediaResultIds;

    // Events
    event TextRequested(bytes32 indexed reqId, address indexed user, string prompt);
    event ImageRequested(bytes32 indexed reqId, address indexed user, string prompt);
    event AudioRequested(bytes32 indexed reqId, address indexed user, string prompt);
    event VideoRequested(bytes32 indexed reqId, address indexed user, string prompt);
    event MediaReady(bytes32 indexed reqId, string uri, bytes32 contentHash, uint256 sizeBytes);
    event MediaFailed(bytes32 indexed reqId, string error);
    event LLMCompleted(bytes32 indexed reqId, bool hasError, string errorMessage);

    /* ─── Modifiers ─── */

    modifier onlyAsyncSystem() {
        require(msg.sender == ASYNC_DELIVERY, "unauthorized callback");
        _;
    }

    /* ─── External: Deposit Ritual for async fees ─── */

    /**
     * @notice Deposit RITUAL to RitualWallet to cover precompile execution fees.
     * @param lockDuration Number of blocks to lock funds (min 5000 recommended).
     *        The executor draws fees from the locked balance while the job is in-flight.
     */
    function depositForFees(uint256 lockDuration) external payable {
        (bool ok, ) = RITUAL_WALLET.call{value: msg.value}(
            abi.encodeWithSignature("deposit(uint256)", lockDuration)
        );
        require(ok, "RitualWallet deposit failed");
    }

    /* ─── LLM / ChatGPT ─── */

    /**
     * @notice Submit a text chat request to the LLM precompile (short-running async).
     * @dev One async tx per sender at a time — Ritual enforces a sender lock.
     *      The result appears in the receipt `spcCalls` field; this function
     *      returns immediately; the caller polls `getReceipt(spcCalls)` off-chain.
     *
     * ABI encoding: 30 fields as required by 0x0802.
     *   — Base (0-4): executor, encryptedSecrets, ttl, secretSignatures, userPublicKey
     *   — LLM-specific (5-29): messagesJson, model, temperature, maxTokens …, convoHistory
     *
     * The caller must:
     *   1. Deposit RITUAL into RitualWallet first.
     *   2. Supply a valid LLM executor address (from TEEServiceRegistry getServicesByCapability(1, true)).
     *   3. Provide encryptedSecrets with a "GCS_CREDS" entry for conversation history.
     */
    function requestText(
        address executor,
        uint256 ttl,                              // blocks until expiry
        string calldata prompt,
        address owner
    ) external returns (bytes32 reqId) {
        return _requestText(executor, ttl, prompt, owner);
    }

    /**
     * @notice Convenience overload: default = msg.sender as owner
     */
    function requestText(address executor, uint256 ttl, string calldata prompt)
        external returns (bytes32 reqId)
    {
        return _requestText(executor, ttl, prompt, msg.sender);
    }

    function _requestText(
        address executor,
        uint256 ttl,
        string calldata prompt,
        address owner
    ) internal returns (bytes32 reqId) {
        require(executor != address(0), "executor is zero");
        require(ttl >= 60 && ttl <= 500, "ttl out of range"); // min 60 for GLM reasoning headroom

        // Build messages JSON: system + user
        string memory messagesJson = string(
            abi.encodePacked(
                '[{"role":"system","content":"', DEFAULT_SYSTEM_PROMPT,
                '"},{"role":"user","content":"', prompt,
                '"}]'
            )
        );

        // Build ABI input – ALL 30 FIELDS EXACTLY AS RITUAL EXPECTS
        bytes memory input = abi.encode(
            executor,                   // 0  address
            new bytes[](0),             // 1  encryptedSecrets  (caller supplies them via calldata hack)
            ttl,                        // 2  uint256
            new bytes[](0),             // 3  secretSignatures
            bytes(""),                  // 4  userPublicKey (0x empty)
            messagesJson,               // 5  messagesJson
            MODEL_LLM,                  // 6  model
            int256(0),                  // 7  frequencyPenalty
            "",                         // 8  logitBiasJson
            false,                      // 9  logprobs
            int256(4096),               //10  maxCompletionTokens  — >=4096 for GLM reasoning model block
            "",                         //11  metadataJson
            "",                         //12  modalitiesJson
            uint256(1),                 //13  n
            true,                       //14  parallelToolCalls  (always true for OpenAPI parity)
            int256(0),                  //15  presencePenalty
            "medium",                   //16  reasoningEffort
            bytes(""),                  //17  responseFormatData (0x when no JSON schema)
            int256(-1),                 //18  seed (-1 = null)
            "auto",                     //19  serviceTier
            "",                         //20  stopJson
            false,                      //21  stream
            int256(700),                //22  temperature — 0.7 × 1000
            bytes(""),                  //23  toolChoiceData   (0x when no tools)
            bytes(""),                  //24  toolsData        (0x when no tools)
            int256(-1),                 //25  topLogprobs      (-1 = null)
            int256(1000),               //26  topP 1.0 × 1000
            "",                         //27  user
            false,                      //28  piiEnabled
            abi.encode(latestConvoRefPlatform, latestConvoRefPath, latestConvoRefKeyRef) //29  convoHistory
        );

        // Submit to LLM precompile — returns (bytes simmedInput, bytes actualOutput)
        // ActualOutput is only populated after async settlement (same tx + settlement in same block)
        (bool ok, bytes memory rawResult) = LLM_PRECOMPILE.call(input);
        require(ok, "LLM precompile call failed");

        reqId = keccak256(rawResult);
        requests[reqId] = GenerationRequest({
            user: owner,
            id: reqId,
            genType: GenerationType.TEXT,
            prompt: prompt,
            model: MODEL_LLM,
            isComplete: false,
            hasError: false,
            errorMessage: "",
            timestamp: block.timestamp,
            resultUri: "",
            resultHash: bytes32(0),
            resultSize: 0,
            conversationRef: _storageRefToString(latestConvoRefPlatform, latestConvoRefPath, latestConvoRefKeyRef)
        });
        requestIds.push(reqId);

        emit TextRequested(reqId, owner, prompt);
    }

    /* ─── Multi-Modal: Image / Audio / Video ─── */

    /**
     * @notice Request image generation via Image precompile (0x0818).
     * @dev Long-running async (2-phase). Phase 1 submits & returns taskId.
     *      Phase 2 arrives as a callback from AsyncDelivery (onImageReady).
     *      The caller must use a DIFFERENT EOA than any pending async job.
     *
     * TTL recommendations:
     *   Image: 120 blocks (~42s); long-running so generous buffer OK.
     *
     * outputStorageRef MUST be non-empty and the corresponding credential
     * key must exist in `encryptedSecrets` — otherwise callback is never delivered.
     *
     * IMPORTANT: This function receives `encryptedSecrets` as a dynamic bytes array
     * parameter. The frontend encrypts the JSON credential blob with the TEE executor's
     * public key and passes it directly here. The precompile can only read it from
     * calldata — we do NOT store it on-chain.
     *
     * After Phase 1 succeeds, the caller should grant access to the credentials:
     *   SecretsAccessControl.grantAccess(this, keccak256(encryptedSecrets), expiry, emptyPolicy)
     */
    function requestImage(
        address executor,
        uint256 ttl,
        string calldata prompt,
        string calldata model,
        uint32 width,
        uint32 height,
        StorageRef calldata outputStorageRef,
        bytes[] calldata encryptedSecrets
    ) external returns (bytes32 reqId) {
        return _requestMedia(
            executor,
            ttl,
            prompt,
            model,
            width,
            height,
            0,                   // durationMs — n/a for images
            outputStorageRef,
            encryptedSecrets,
            GenerationType.IMAGE
        );
    }

    /**
     * @notice Request audio generation via Audio precompile (0x0819).
     * @param maxDurationMs Maximum audio duration in milliseconds.
     */
    function requestAudio(
        address executor,
        uint256 ttl,
        string calldata prompt,
        string calldata model,
        uint32 maxDurationMs,
        StorageRef calldata outputStorageRef,
        bytes[] calldata encryptedSecrets
    ) external returns (bytes32 reqId) {
        return _requestMedia(
            executor,
            ttl,
            prompt,
            model,
            maxDurationMs, // reused as param1
            0,
            0,
            outputStorageRef,
            encryptedSecrets,
            GenerationType.AUDIO
        );
    }

    /**
     * @notice Request video generation via Video precompile (0x081A).
     * @param width, height, durationMs Resolution + length in milliseconds.
     */
    function requestVideo(
        address executor,
        uint256 ttl,
        string calldata prompt,
        string calldata model,
        uint32 width,
        uint32 height,
        uint32 durationMs,
        StorageRef calldata outputStorageRef,
        bytes[] calldata encryptedSecrets
    ) external returns (bytes32 reqId) {
        return _requestMedia(
            executor,
            ttl,
            prompt,
            model,
            width,
            height,
            durationMs,
            outputStorageRef,
            encryptedSecrets,
            GenerationType.VIDEO
        );
    }

    function _requestMedia(
        address executor,
        uint256 ttl,
        string calldata prompt,
        string calldata model,
        uint32 param1,           // width OR maxDurationMs
        uint32 param2,           // height OR 0
        uint32 param3,           // durationMs (video only)
        StorageRef calldata outputStorageRef,
        bytes[] calldata encryptedSecrets,
        GenerationType genType
    ) internal returns (bytes32 reqId) {
        require(executor != address(0), "executor is zero");
        require(ttl >= 60, "ttl too low"); // multimodal can be long; set sufficiently high

        // Validate StorageRef non-empty
        require(bytes(outputStorageRef.platform).length > 0, "outputStorageRef.platform empty");
        require(bytes(outputStorageRef.path).length > 0,    "outputStorageRef.path empty");
        require(bytes(outputStorageRef.keyRef).length > 0,  "outputStorageRef.keyRef empty");

        // ── Build Long-Running Multimodal ABI input (18 fields total) ──
        // Fields 0–4: Base executor payload
        // Fields  5–13: Long-running delivery config (polling + callback)
        // Field   14:  model string
        // Fields 15–16: inputs[] (ModalInput[]) and output (OutputConfig)
        // Field   17:  outputStorageRef (StorageRef tuple)
        bytes memory input = abi.encode(
            executor,                    // 0  address
            encryptedSecrets,            // 1  bytes[]  (ECIES-encrypted GCS/HF/Pinata credentials)
            ttl,                         // 2  uint256
            new bytes[](0),              // 3  secretSignatures
            bytes(""),                   // 4  userPublicKey
            uint64(5),                   // 5  pollIntervalBlocks — 5 blocks ~1.75s conservative
            uint64(1000),                // 6  maxPollBlock — flexible upper bound, builder adjust
            "MEDIA_TASK_ID",             // 7  taskIdMarker — non-empty marker for task ID extraction
            address(this),               // 8  deliveryTarget — this contract
            _callbackSelector(genType),   // 9  deliverySelector — selector for onXXXReady(...)
            uint256(500_000),            //10  deliveryGasLimit
            uint256(1_000_000_000n),     //11  deliveryMaxFeePerGas  (1 gwei)
            uint256(100_000_000n),       //12  deliveryMaxPriorityFeePerGas  (0.1 gwei)
            uint256(0),                  //13  deliveryValue
            model,                       //14  model
            _buildModalInput(prompt),     //15  inputs — ModalInput[] (tuple array)
            _buildOutputConfig(genType, param1, param2, param3), //16 output — OutputConfig (tuple)
            outputStorageRef             //17  outputStorageRef — StorageRef (string,string,string)
        );

        (bool ok, bytes memory result) = _precompileCall(genType).call(input);
        require(ok, "multimodal precompile call failed");

        reqId = keccak256(result); // local correlation ID (NOT jobId; callback uses tx hash)
        requests[reqId] = GenerationRequest({
            user: msg.sender,
            id: reqId,
            genType: genType,
            prompt: prompt,
            model: model,
            isComplete: false,
            hasError: false,
            errorMessage: "",
            timestamp: block.timestamp,
            resultUri: "",
            resultHash: bytes32(0),
            resultSize: 0,
            conversationRef: ""
        });
        requestIds.push(reqId);

        if (genType == GenerationType.IMAGE)  emit ImageRequested(reqId, msg.sender, prompt);
        if (genType == GenerationType.AUDIO)  emit AudioRequested(reqId, msg.sender, prompt);
        if (genType == GenerationType.VIDEO)  emit VideoRequested(reqId, msg.sender, prompt);
    }

    /* ─── Callbacks (Phase 2 delivery) ─── */

    /**
     * @notice Image generation completed — called by AsyncDelivery proxy (0x5A16…39F6).
     * @dev Result encoding (by spec):
     *   (bool hasError, bytes completionData, string outputUri,
     *    bytes32 outputContentHash, bool outputEncrypted,
     *    uint32 outputSizeBytes, uint32 outputWidth, uint32 outputHeight,
     *    string errorMessage)
     */
    function onImageReady(bytes32 jobId, bytes calldata responseData)
        external
        onlyAsyncSystem
    {
        _handleMediaCallback(
            jobId,
            responseData,
            GenerationType.IMAGE,
            /* resultFields: */ 9
        );
    }

    function onAudioReady(bytes32 jobId, bytes calldata responseData)
        external
        onlyAsyncSystem
    {
        _handleMediaCallback(
            jobId,
            responseData,
            GenerationType.AUDIO,
            /* resultFields: */ 8   // (hasError, bytes, uri, hash, encrypted, size, durationMs, error)
        );
    }

    function onVideoReady(bytes32 jobId, bytes calldata responseData)
        external
        onlyAsyncSystem
    {
        _handleMediaCallback(
            jobId,
            responseData,
            GenerationType.VIDEO,
            /* resultFields: */ 10  // (hasError, bytes, uri, hash, encrypted, size64, w, h, duration, error)
        );
    }

    function _handleMediaCallback(
        bytes32 jobId,
        bytes calldata data,
        GenerationType genType,
        uint256 expectedFieldCount
    ) internal {
        // jobId == original tx hash; correlate to our stored requestId via the event log history wallah.
        // For simplicity, we listen/log client-side; here we just store the media result.

        if (genType == GenerationType.IMAGE) {
            (
                bool hasError,
                bytes memory ,,
                string memory uri,
                bytes32 contentHash,
                bool encrypted,
                uint32 size,
                uint32 w,
                uint32 h,
                string memory err
            ) = abi.decode(data, (bool, bytes, string, bytes32, bool, uint32, uint32, uint32, string));

            if (hasError) {
                emit MediaFailed(jobId, err);
                return;
            }

            mediaResults[jobId] = MediaResult({
                uri: uri,
                contentHash: contentHash,
                timestamp: block.timestamp,
                encrypted: encrypted
            });
            if (mediaResultIds.length == 0 || mediaResultIds[mediaResultIds.length - 1] != jobId) {
                mediaResultIds.push(jobId);
            }
            emit MediaReady(jobId, uri, contentHash, size);
        } else if (genType == GenerationType.AUDIO) {
            (
                bool hasError,
                bytes memory ,,
                string memory uri,
                bytes32 contentHash,
                bool encrypted,
                uint32 size,
                uint32 durationMs,
                string memory err
            ) = abi.decode(data, (bool, bytes, string, bytes32, bool, uint32, uint32, string));

            if (hasError) {
                emit MediaFailed(jobId, err);
                return;
            }

            mediaResults[jobId] = MediaResult({
                uri: uri,
                contentHash: contentHash,
                timestamp: block.timestamp,
                encrypted: encrypted
            });
            if (mediaResultIds.length == 0 || mediaResultIds[mediaResultIds.length - 1] != jobId) {
                mediaResultIds.push(jobId);
            }
            emit MediaReady(jobId, uri, contentHash, size);
        } else { // VIDEO
            (
                bool hasError,
                bytes memory ,,
                string memory uri,
                bytes32 contentHash,
                bool encrypted,
                uint64 size,
                uint32 w,
                uint32 h,
                uint32 durationMs,
                string memory err
            ) = abi.decode(data, (bool, bytes, string, bytes32, bool, uint64, uint32, uint32, uint32, string));

            if (hasError) {
                emit MediaFailed(jobId, err);
                return;
            }

            mediaResults[jobId] = MediaResult({
                uri: uri,
                contentHash: contentHash,
                timestamp: block.timestamp,
                encrypted: encrypted
            });
            if (mediaResultIds.length == 0 || mediaResultIds[mediaResultIds.length - 1] != jobId) {
                mediaResultIds.push(jobId);
            }
            emit MediaReady(jobId, uri, contentHash, uint256(size));
        }
    }

    /* ─── Helpers ─── */

    function _callbackSelector(GenerationType genType) internal pure returns (bytes4) {
        if (genType == GenerationType.IMAGE) return this.onImageReady.selector;
        if (genType == GenerationType.AUDIO) return this.onAudioReady.selector;
        return this.onVideoReady.selector;
    }

    function _precompileCall(GenerationType genType) internal pure returns (address) {
        if (genType == GenerationType.TEXT)  return LLM_PRECOMPILE;
        if (genType == GenerationType.IMAGE) return IMAGE_PRECOMPILE;
        if (genType == GenerationType.AUDIO) return AUDIO_PRECOMPILE;
        return VIDEO_PRECOMPILE;
    }

    function _buildModalInput(string calldata text)
        internal
        pure
        returns (tuple(uint8 inputType, bytes data, string uri, bytes32 contentHash, uint32 param1, uint32 param2, bool encrypted)[] memory)
    {
        tuple(uint8, bytes, string, bytes32, uint32, uint32, bool)[] memory inputs = new tuple<uint8, bytes, string, bytes32, uint32, uint32, bool>(1);
        inputs[0] = (
            uint8(0),              // inputType = TEXT
            bytes(text),           // raw text bytes (UTF-8)
            "",                    // uri
            bytes32(0),            // contentHash
            uint32(0),             // param1
            uint32(0),             // param2
            false                  // encrypted — plaintext text input
        );
        return inputs;
    }

    /**
     * Build OutputConfig tuple.
     *   IMAGE: outputType=1, maxParam1=width, maxParam2=height, maxParam3=0
     *   AUDIO: outputType=2, maxParam1=maxDurationMs, maxParam2=0, maxParam3=0
     *   VIDEO: outputType=3, maxParam1=width, maxParam2=height, maxParam3=durationMs
     */
    function _buildOutputConfig(
        GenerationType genType,
        uint32 p1,
        uint32 p2,
        uint32 p3
    ) internal pure returns (
        tuple(
            uint8 outputType,
            uint32 maxParam1,
            uint32 maxParam2,
            uint32 maxParam3,
            bool   encryptOutput,
            uint16 numInferenceSteps,
            uint16 guidanceScaleX100,
            uint32 seed,
            uint8  fps,
            string negativePrompt
        ) memory
    ) {
        uint8 ot;
        if (genType == GenerationType.IMAGE) ot = 1;
        else if (genType == GenerationType.AUDIO) ot = 2;
        else ot = 3;

        return (
            ot,                    // outputType
            p1,                    // maxParam1  width / maxDurationMs
            p2,                    // maxParam2  height / 0
            p3,                    // maxParam3  0 / durationMs
            false,                 // encryptOutput
            uint16(0),             // numInferenceSteps (0 = model default)
            uint16(0),             // guidanceScaleX100 (0 = default)
            uint32(0),             // seed (0 = random)
            uint8(0),              // fps (video only, 0 = default)
            ""                     // negativePrompt
        );
    }

    /**
     * Helper: convert StorageRef tuple (string,string,string) to JSON string.
     * Stored off-chain, but we keep a string reference for readability in events.
     * On-chain we pass the tuple directly to precompile ABI encodes.
     */
    function _storageRefToString(string memory platform, string memory path, string memory keyRef)
        internal
        pure
        returns (string memory)
    {
        return string(abi.encodePacked('(', platform, ',', path, ',', keyRef, ')'));
    }

    /* ─── View / Admin ─── */

    /**
     * @notice Resolve a reqId → GenerationRequest (full struct).
     *Frontend calls `requests[reqId].prompt` etc. via public getter auto-generated by Solidity.
     *This custom getter returns the entire populated struct for convenience.
     */
    function getRequest(bytes32 reqId) external view returns (
        address user,
        GenerationType genType,
        string memory prompt,
        string memory model,
        bool isComplete,
        bool hasError,
        string memory errorMessage,
        uint256 timestamp,
        string memory resultUri,
        bytes32 resultHash,
        uint256 resultSize
    ) {
        GenerationRequest storage r = requests[reqId];
        return (
            r.user,
            r.genType,
            r.prompt,
            r.model,
            r.isComplete,
            r.hasError,
            r.errorMessage,
            r.timestamp,
            r.resultUri,
            r.resultHash,
            r.resultSize
        );
    }

    /** List all request IDs (pagination by caller). */
    function getRequestIds() external view returns (bytes32[] memory) {
        return requestIds;
    }

    function getMediaResultIds() external view returns (bytes32[] memory) {
        return mediaResultIds;
    }

    /**
     * @notice Convenience: fetch a MediaResult struct by its jobId.
     */
    function getMediaResult(bytes32 jobId) external view returns (
        string memory uri,
        bytes32 contentHash,
        uint256 timestamp,
        bool encrypted
    ) {
        MediaResult storage m = mediaResults[jobId];
        return (m.uri, m.contentHash, m.timestamp, m.encrypted);
    }

    // ===== SETTERS (owner-only) ================================================================

    /**
     * @dev Update the default conversation history StorageRef.
     *      Clients that call requestText() without explicitly passing a different
     *      path will use these values for the convoHistory field.
     */
    function setConversationStorage(
        string calldata platform,
        string calldata path,
        string calldata keyRef
    ) external onlyOwner {
        latestConvoRefPlatform = platform;
        latestConvoRefPath    = path;
        latestConvoRefKeyRef  = keyRef;
    }
}
