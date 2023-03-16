export class AsyncController<Task, Result> {
    concurrency: number;
    work: (task: Task) => Promise<Result>;
    onFinish: (result: Result, index: number, task: Task) => any;
    tasks: Task[];
    paused: boolean = false;

    constructor({ concurrency, work, tasks, onFinish }: { concurrency: number, tasks: Task[], work: (task: Task) => Promise<Result>, onFinish: (result: Result, index: number, task: Task) => any }) {
        this.concurrency = concurrency;
        this.work = work;
        this.onFinish = onFinish;
        this.tasks = tasks;
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    async run() {
        const remainTasks = this.tasks.concat([]);
        const resultMap: Record<number, Result> = {};
        let firstFinish = -1;
        let currentTaskIndex = 0;

        const queueList = [];
        for (let i = 0; i < this.concurrency; i++) {
            const queue = (async () => {

                while (remainTasks.length > 0) {
                    const index = currentTaskIndex;
                    currentTaskIndex++;
                    const task = remainTasks.shift();
                    if (task) {
                        const result = await this.work(task);
                        resultMap[index] = result;

                        if (resultMap[firstFinish + 1] != null) {
                            firstFinish++;
                            const data = resultMap[firstFinish];
                            this.onFinish(data, firstFinish, task);
                            delete resultMap[firstFinish];
                        }   
                    }

                    while (this.paused) {
                        await new Promise(res => setTimeout(res, 10));
                    }
                }
            })();

            queueList.push(queue);
        }

        await Promise.all(queueList);
        while (firstFinish + 1 < this.tasks.length) {
            firstFinish++;
            const data = resultMap[firstFinish];
            this.onFinish(data, firstFinish, this.tasks[firstFinish]);
            delete resultMap[firstFinish];
        }
    }
}