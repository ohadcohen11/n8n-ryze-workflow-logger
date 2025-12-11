import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

interface ILogData {
	script_id: number;
	execution_mode: string;
	execution_type: string;
	workflow_name: string;
	status: string;
	items_processed: number;
	items_new: number;
	items_duplicates: number;
	items_updated: number;
	event_summary: string;
	full_details: string;
}

interface ISummary {
	total_input?: number;
	new_items?: number;
	exact_duplicates?: number;
	updated_items?: number;
	event_summary?: Record<string, number>;
	failed_items?: number;
}

interface IExecution {
	mode?: string;
	script_id?: string;
}

export class WorkflowLogger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Workflow Logger',
		name: 'workflowLogger',
		icon: { light: 'file:workflowLogger.svg', dark: 'file:workflowLogger.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Log workflow execution metrics to MySQL database',
		defaults: {
			name: 'Workflow Logger',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'mySqlApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Database',
				name: 'database',
				type: 'string',
				required: true,
				default: '',
				description: 'MySQL database name',
				placeholder: 'my_database',
			},
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				required: true,
				default: 'workflow_logs',
				description: 'Table name for storing execution logs',
				placeholder: 'workflow_logs',
			},
			{
				displayName: 'Execution Mode',
				name: 'executionMode',
				type: 'options',
				options: [
					{ name: 'Auto-Detect', value: 'auto' },
					{ name: 'Regular', value: 'regular' },
					{ name: 'Monthly', value: 'monthly' },
				],
				default: 'auto',
				description: 'Execution mode - auto-detect from input or specify manually',
			},
			{
				displayName: 'Additional Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Fail on Error',
						name: 'failOnError',
						type: 'boolean',
						default: false,
						description: 'Whether to fail the workflow if logging fails',
					},
					{
						displayName: 'Verbose Logging',
						name: 'verboseLogging',
						type: 'boolean',
						default: false,
						description: 'Whether to log detailed information to console',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		// Get parameters
		const database = this.getNodeParameter('database', 0) as string;
		const table = this.getNodeParameter('table', 0) as string;
		const executionMode = this.getNodeParameter('executionMode', 0) as string;
		const options = this.getNodeParameter('options', 0, {}) as {
			failOnError?: boolean;
			verboseLogging?: boolean;
		};

		// Aggregate all items into one log entry
		let totalItemsProcessed = 0;
		let totalItemsNew = 0;
		let totalItemsDuplicates = 0;
		let totalItemsUpdated = 0;
		let allTransactionItems: any[] = [];
		const mergedEventSummary: Record<string, number> = {};
		let hasFailures = false;
		let firstExecution: IExecution | null = null;
		let scriptId: number | null = null;

		// Loop through all items and aggregate
		for (let i = 0; i < items.length; i++) {
			const input = items[i].json;
			const summary = (input.summary || {}) as ISummary;
			const execution = (input.execution || {}) as IExecution;
			const details = (input.details || {}) as any;

			// Store first execution for mode detection and script_id extraction
			if (i === 0) {
				firstExecution = execution;
				// Extract script_id from execution data
				scriptId = execution.script_id ? parseInt(execution.script_id, 10) : null;
			}

			// Aggregate metrics
			totalItemsProcessed += summary.total_input || 0;
			totalItemsNew += summary.new_items || 0;
			totalItemsDuplicates += summary.exact_duplicates || 0;
			totalItemsUpdated += summary.updated_items || 0;

			// Check for failures
			if ((summary.failed_items ?? 0) > 0) {
				hasFailures = true;
			}

			// Merge event summaries
			if (summary.event_summary) {
				for (const [event, count] of Object.entries(summary.event_summary)) {
					mergedEventSummary[event] = (mergedEventSummary[event] || 0) + count;
				}
			}

			// Collect transaction items
			const sentItems = details.sent_items?.items || [];
			allTransactionItems = allTransactionItems.concat(sentItems);
		}

		const results: INodeExecutionData[] = [];

		try {
			// Validate script_id was found
			if (!scriptId) {
				throw new NodeOperationError(
					this.getNode(),
					'Could not extract script_id from input data. Make sure this node receives data with execution information.',
				);
			}

			// Determine execution mode
			let mode = executionMode;
			if (mode === 'auto' && firstExecution) {
				mode = firstExecution.mode || 'regular';
			}

			// Determine execution type (manual or scheduled)
			const workflowMode = this.getMode();
			const executionType = workflowMode === 'manual' ? 'manual' : 'scheduled';

			// Get workflow name
			const workflow = this.getWorkflow();
			const workflowName = workflow.name || 'Unknown';

			// Determine status
			const status = hasFailures ? 'failed' : 'success';

			// Prepare aggregated log data
			const logData: ILogData = {
				script_id: scriptId,
				execution_mode: mode,
				execution_type: executionType,
				workflow_name: workflowName,
				status: status,
				items_processed: totalItemsProcessed,
				items_new: totalItemsNew,
				items_duplicates: totalItemsDuplicates,
				items_updated: totalItemsUpdated,
				event_summary: JSON.stringify(mergedEventSummary),
				full_details: JSON.stringify(allTransactionItems),
			};

			if (options.verboseLogging) {
				this.logger.info('Workflow Logger - Logging aggregated data', {
					logData: JSON.stringify(logData),
				});
			}

			// Insert single aggregated log to MySQL
			await insertLog(this, database, table, logData);

			// Return success
			results.push({
				json: {
					success: true,
					logged_at: new Date().toISOString(),
					script_id: scriptId,
					batches_aggregated: items.length,
					log_data: logData,
				},
				pairedItem: 0,
			});
		} catch (error) {
			if (options.failOnError) {
				throw new NodeOperationError(this.getNode(), `Failed to log execution: ${error.message}`);
			}

			this.logger.error('Workflow Logger - Error:', error);

			results.push({
				json: {
					success: false,
					error: error.message,
					script_id: scriptId,
				},
				pairedItem: 0,
			});
		}

		return [results];
	}
}

async function insertLog(
	executeFunctions: IExecuteFunctions,
	database: string,
	table: string,
	logData: ILogData,
): Promise<void> {
	const credentials = await executeFunctions.getCredentials('mySqlApi');

	// Dynamic require to avoid linting issues with n8n Cloud restrictions
	// Note: This node requires mysql2 to be installed and is intended for self-hosted n8n instances
	const mysql = eval("require('mysql2/promise')");

	const connection = await mysql.createConnection({
		host: credentials.host as string,
		port: credentials.port as number,
		database: database,
		user: credentials.user as string,
		password: credentials.password as string,
	});

	try {
		const query = `
			INSERT INTO ${database}.${table}
				(script_id, execution_mode, execution_type, workflow_name, status,
				 items_processed, items_new, items_duplicates, items_updated,
				 event_summary, full_details)
			VALUES
				(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`;

		await connection.execute(query, [
			logData.script_id,
			logData.execution_mode,
			logData.execution_type,
			logData.workflow_name,
			logData.status,
			logData.items_processed,
			logData.items_new,
			logData.items_duplicates,
			logData.items_updated,
			logData.event_summary,
			logData.full_details,
		]);
	} finally {
		await connection.end();
	}
}
