export type AutomationStatus = {
    id: string;
    status: 'running' | 'completed' | 'error' | 'paused';
    progress: number;
    message?: string;
    details?: {
        sku?: string;
        asin?: string;
        price?: number;
        condition?: "Used - Like New" | "Used - Very Good" | "Used - Good" | "Used - Acceptable";
        conditionNotes?: string;
    };
}; 