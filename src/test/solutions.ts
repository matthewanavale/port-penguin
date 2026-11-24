// AC4: one explicit solution per task, in order. One path only, never the
// alternatives a hint offers. Each list runs in the same game, after the
// lists before it, from a fresh game with START_MS and SEED (D15b).

export interface Solution {
  /** 1-based task number, as the panel shows it. */
  task: number;
  /** Must equal M[task - 1].title, so the list stays in step with the tasks. */
  title: string;
  commands: string[];
}

export const SOLUTIONS: Solution[] = [
  // 1. Getting around
  { task: 1, title: "Where am I?", commands: ["pwd"] },
  { task: 2, title: "Look around", commands: ["ls"] },
  { task: 3, title: "Read the welcome note", commands: ["cat welcome.txt"] },
  { task: 4, title: "Hidden things", commands: ["ls -a", "cat .secret"] },
  { task: 5, title: "Change rooms", commands: ["cd projects/webapp"] },
  { task: 6, title: "Home sweet home", commands: ["cd ~"] },
  // 2. Handling files
  { task: 7, title: "Make a folder", commands: ["mkdir backups"] },
  {
    task: 8,
    title: "Write a file",
    commands: ['echo "check the cargo" > todo.txt'],
  },
  {
    task: 9,
    title: "Add a line",
    commands: ['echo "feed the seagulls" >> todo.txt'],
  },
  { task: 10, title: "Make a copy", commands: ["cp notes.txt backups/"] },
  { task: 11, title: "Rename it", commands: ["mv todo.txt tasks.txt"] },
  { task: 12, title: "Clear the clutter", commands: ["rm /tmp/old-cargo.log"] },
  {
    task: 13,
    title: "Folders inside folders",
    commands: ["mkdir -p archive/2026/november"],
  },
  {
    task: 14,
    title: "Copy a whole folder",
    commands: ["cp -r backups archive/2026/november/"],
  },
  // 3. Reading & searching
  { task: 15, title: "Just the top", commands: ["head -n 3 logs/system.log"] },
  {
    task: 16,
    title: "The latest news",
    commands: ["tail -n 2 logs/system.log"],
  },
  {
    task: 17,
    title: "Find the errors",
    commands: ["grep ERROR logs/system.log"],
  },
  {
    task: 18,
    title: "Count them",
    commands: ["grep ERROR logs/system.log | wc -l"],
  },
  {
    task: 19,
    title: "Case doesn’t matter",
    commands: ["grep -i seagull logs/system.log"],
  },
  {
    task: 20,
    title: "Which line?",
    commands: ['grep -n "Gate B" logs/system.log'],
  },
  {
    task: 21,
    title: "Lost and found",
    commands: ["find projects -name crate-manifest.txt"],
  },
  { task: 22, title: "Every log file", commands: ['find ~ -name "*.log"'] },
  { task: 23, title: "Line up the crew", commands: ["sort crew.txt"] },
  { task: 24, title: "No duplicates", commands: ["sort crew.txt | uniq"] },
  // 4. Permissions & scripts
  {
    task: 25,
    title: "Read the fine print",
    commands: ["ls -l projects/webapp"],
  },
  {
    task: 26,
    title: "Permission to launch",
    commands: ["cd ~/projects/webapp", "chmod +x deploy.sh", "./deploy.sh"],
  },
  { task: 27, title: "Top secret", commands: ["chmod 600 ~/notes.txt"] },
  {
    task: 28,
    title: "Write your own script",
    commands: [
      "cd ~",
      'echo "echo Ahoy" > hello.sh',
      "chmod +x hello.sh",
      "./hello.sh",
    ],
  },
  { task: 29, title: "Remember this", commands: ["CREW=Marina", "echo $CREW"] },
  {
    task: 30,
    title: "Pack it up",
    commands: ["tar -czf backups.tar.gz backups"],
  },
  { task: 31, title: "Peek inside", commands: ["tar -tzf backups.tar.gz"] },
  {
    task: 32,
    title: "Unpack somewhere else",
    commands: ["tar -xzf backups.tar.gz -C /tmp"],
  },
  // 5. Processes & system
  { task: 33, title: "Who’s running?", commands: ["ps"] },
  { task: 34, title: "The CPU hog", commands: ["top"] },
  { task: 35, title: "Stop the loop", commands: ["kill 4242"] },
  { task: 36, title: "The stubborn one", commands: ["kill -9 4343"] },
  { task: 37, title: "Disk check", commands: ["df -h"] },
  { task: 38, title: "What takes space?", commands: ["du -sh ~"] },
  // 6. Docker basics
  {
    task: 39,
    title: "Your first container",
    commands: ["docker run hello-world"],
  },
  { task: 40, title: "Stock the yard", commands: ["docker pull nginx"] },
  { task: 41, title: "Check the inventory", commands: ["docker images"] },
  {
    task: 42,
    title: "Run it in the background",
    commands: ["docker run -d --name web -p 8080:80 nginx"],
  },
  { task: 43, title: "What’s running?", commands: ["docker ps"] },
  { task: 44, title: "Pay a visit", commands: ["curl localhost:8080"] },
  { task: 45, title: "Read the logs", commands: ["docker logs web"] },
  {
    task: 46,
    title: "Step inside",
    commands: ["docker exec web ls /usr/share/nginx/html"],
  },
  {
    task: 47,
    title: "Unload the ship",
    commands: ["docker stop web && docker rm web"],
  },
  {
    task: 48,
    title: "Build your own",
    commands: ["cd ~/projects/webapp", "docker build -t myapp ."],
  },
  {
    task: 49,
    title: "Launch day",
    commands: ["docker run -d --name myapp -p 5000:5000 myapp"],
  },
  // 7. Docker networks & data
  { task: 50, title: "The full picture", commands: ["docker ps -a"] },
  {
    task: 51,
    title: "Sweep the deck",
    commands: ["docker container prune -f"],
  },
  { task: 52, title: "Clear the shelf", commands: ["docker rmi hello-world"] },
  {
    task: 53,
    title: "A database appears",
    commands: ["docker run -d --name db postgres"],
  },
  { task: 54, title: "Why did it stop?", commands: ["docker logs db"] },
  {
    task: 55,
    title: "Fix the database",
    commands: [
      "docker rm db",
      "docker run -d --name db -e POSTGRES_PASSWORD=secret postgres",
    ],
  },
  { task: 56, title: "Where’s the database?", commands: ["docker inspect db"] },
  {
    task: 57,
    title: "Safe storage",
    commands: ["docker volume create harbor-data"],
  },
  {
    task: 58,
    title: "Mount the volume",
    commands: ["docker run -d --name cache -v harbor-data:/data redis"],
  },
  {
    task: 59,
    title: "A private network",
    commands: ["docker network create harbor-net"],
  },
  {
    task: 60,
    title: "Plug it in",
    commands: ["docker network connect harbor-net cache"],
  },
  {
    task: 61,
    title: "Can you hear me?",
    commands: ["docker run --rm --network harbor-net alpine ping -c 1 cache"],
  },
  // 8. Compose & challenges
  {
    task: 62,
    title: "One file to rule them all",
    commands: ["cd ~/projects/stack", "cat docker-compose.yml"],
  },
  { task: 63, title: "Raise the stack", commands: ["docker compose up -d"] },
  { task: 64, title: "Stack status", commands: ["docker compose ps"] },
  { task: 65, title: "Strike the stack", commands: ["docker compose down"] },
  {
    task: 66,
    title: "Challenge: squatter",
    commands: [
      "docker rm -f squatter",
      "docker run -d --name harbor -p 8080:5000 myapp",
    ],
  },
  {
    task: 67,
    title: "Challenge: broken build",
    commands: [
      "cd ~/projects/broken",
      "sed -i 's/FORM/FROM/' Dockerfile",
      "docker build -t fixed .",
    ],
  },
  {
    task: 68,
    title: "Challenge: disk full",
    commands: ["rm /var/log/crane-debug.log"],
  },
  {
    task: 69,
    title: "Challenge: log detective",
    commands: [
      "cd ~",
      "awk '{print $3}' logs/system.log | sort | uniq -c | sort -rn",
    ],
  },
  {
    task: 70,
    title: "Final mission: ship 1.0",
    commands: [
      "docker tag myapp myapp:1.0",
      "docker run -d --name app-prod --network harbor-net -p 9000:5000 myapp:1.0",
    ],
  },
];
