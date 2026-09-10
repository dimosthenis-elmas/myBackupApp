  import {SelectionModel} from '@angular/cdk/collections';
  import {FlatTreeControl} from '@angular/cdk/tree';
  import {Component, EventEmitter, Injectable, Input, Output} from '@angular/core';
  import {MatTreeFlatDataSource, MatTreeFlattener} from '@angular/material/tree';
  import {BehaviorSubject} from 'rxjs';
  
  /**
   * Node for to-do item
   */
  export class TodoItemNode {
    children!: TodoItemNode[];
    item!: string;
    // optional, extra data associated with the item.
    extras: any;
  }
  
  /** Flat to-do item node with expandable and level information */
  export class TodoItemFlatNode {
    item!: string;
    level!: number;
    expandable!: boolean;
    // optional, extra data associated with the item.
    extras: any;
  }
  
  /** Converts an array of strings (file paths) to a json object readable by angular's mat-tree.
   * @param files an array of strings (paths to a file or empty_folder). Example ['1.txt', 'folder1\2.txt', 'folder1\3.txt', 'folder1\empty_folder\', 'folder1\empty_folder1\empty_folder2\', '4.txt']
   * @return a json object that can be used in an angular mat-tree. Example {"1.txt":null, folder1:{"2.txt":null, "3.txt":null, empty_folder:{}, empty_folder1:{empty_folder2:{}}}, "4.txt":null}
   */
  const list_to_json_ = function(files: any[]){
    let root = {};
    files.forEach(function(file){
      let tokens = file.split('\\');
      let head:any = root;
      let lastTokenIndex = tokens.length-1;
      // Inform the "root" object about the directory structure that leads to this "file" (or "empty folder")
      for(let i=0; i<lastTokenIndex; ++i){
        if(!head.hasOwnProperty(tokens[i])){
          // Create property for this folder
          head[tokens[i]] = {};
        }
        // "cd" to this folder 
        head = head[tokens[i]];
      }
      // You reached the bottom! Is it a "file" or an "empty folder"
      if(tokens[lastTokenIndex] != ''){
        // It was a file!
        head[tokens[lastTokenIndex]] = null;
      }
    });
    return root;
  }

  /** How often (every Nth item processed) list_to_json/buildFileTree below yield to the event loop and report
   *  progress - frequently enough for a progress bar bound to it to look smooth, rarely enough not to spend
   *  more time yielding than actually working on a huge tree. */
  const TREE_BUILD_PROGRESS_REPORT_INTERVAL = 25;

  const yieldToEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  // New version including Extras (additional info not displayed, but retained in the 'database'). Async (unlike
  // the synchronous list_to_json_ above) so it can yield periodically on a huge file list instead of blocking
  // the renderer thread for its entire duration in one go - the same reason buildFileTree below already yields -
  // and so it can report real progress via `onProgress` (files.length is a known total up front, unlike
  // buildFileTree's own node count - see FilesTreeComponent.setTreeData for how the two phases are combined).
  const list_to_json = async function(files: any[], extras: any[] = [], onProgress?: (itemsProcessed: number) => void){
    let root = {};
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      let tokens = file.split('\\');
      let head:any = root;
      let lastTokenIndex = tokens.length-1;
      // Inform the "root" object about the directory structure that leads to this "file" (or "empty folder")
      for(let i=0; i<lastTokenIndex; ++i){
        if(!head.hasOwnProperty(tokens[i])){
          // Create property for this folder

          // Extras is optional ..
          let e: any = null;
          if(extras.length > 0){
            e = extras[index];
          }
          head[tokens[i]] = {"children":{}, "extras": e};
        }
        // "cd" to this folder
        head = head[tokens[i]].children;
      }
      // You reached the bottom! Is it a "file" or an "empty folder"
      if(tokens[lastTokenIndex] != ''){
        // It was a file!

        // Extras is optional ..
        let e: any = null;
        if(extras.length > 0){
          e = extras[index];
        }
        head[tokens[lastTokenIndex]] = {"children": null, "extras": e};
      }
      if ((index + 1) % TREE_BUILD_PROGRESS_REPORT_INTERVAL === 0) {
        onProgress?.(index + 1);
        await yieldToEventLoop();
      }
    }
    return root;
  }

  /**
   * Checklist database, it can build a tree structured Json object.
   * Each node in Json object represents a to-do item or a category.
   * If a node is a category, it has children items and new items can be added under the category.
   */
  @Injectable()
  export class ChecklistDatabase {
    dataChange = new BehaviorSubject<TodoItemNode[]>([]);

    /** The current file/folder tree, as a nested JSON object (see list_to_json). Used to be a module-level
     *  variable (TREE_DATA) shared across every ChecklistDatabase/FilesTreeComponent instance in the whole
     *  app - harmless only because every current caller happens to await setTreeData() sequentially (see
     *  backup-to-optical-media.component.ts's createTrees, the one place with multiple simultaneous
     *  <files-tree> instances on screen at once), but a real landmine for any future concurrent usage: two
     *  trees calling setTreeData around the same time would race on the same shared variable. Now scoped to
     *  this instance instead, matching how ChecklistDatabase itself is already instantiated per-component
     *  (see the `providers: [ChecklistDatabase]` on FilesTreeComponent's @Component decorator). */
    private treeData: any = {};

    get data(): TodoItemNode[] { return this.dataChange.value; }

    /** Deliberately does NOT call initialize() here (it used to). dataChange already starts at its own default
     *  value ([]), which is exactly what initialize() would have (redundantly) recomputed from the still-empty
     *  treeData at this point - so calling it here achieves nothing a caller could ever observe, while creating
     *  a real race: initialize() is async (buildFileTree has its own ~20%-chance setTimeout(0) yield per tree
     *  level - see its own comment), so this constructor-triggered call is still in flight, with nothing
     *  forcing it to finish first, at the exact moment a caller can turn around and call setTreeData() on a
     *  just-constructed instance (see backup-to-optical-media.component.ts's maybeAppendOverflowDiscs, which
     *  does exactly that for a freshly-appended disc's tree). If THIS stray call happened to resolve AFTER
     *  setTreeData()'s own initialize() call - plausible, since either can yield independently - its
     *  dataChange.next([]) would fire last and silently wipe out the real data setTreeData() had just set,
     *  leaving the tree looking (and actually being, per checklistSelection/treeControl.dataNodes) empty - e.g. a
     *  freshly-appended overflow disc's tree rendering empty, with getSelectedFilePathsIncludingExtraInfo()
     *  correctly finding nothing selected and tripping sendToImgBurn's own "no files selected" guard - a genuine
     *  data-level empty selection, not just a cosmetic rendering gap. Removing this call closes the race outright:
     *  only ever one initialize() in flight per instance
     *  (whichever setTreeData() explicitly triggers), so there is nothing left for it to lose a race against. */
    constructor() {
    }

    /** Replaces this instance's tree data and rebuilds the displayed tree from it - see
     *  FilesTreeComponent.setTreeData, the only caller. `onProgress` (optional) reports the running count of
     *  TodoItemNodes built so far - see buildFileTree's own counter param for why this is a running count, not
     *  a percentage, on its own. */
    async setTreeData(treeData: any, onProgress?: (nodesBuiltSoFar: number) => void): Promise<void> {
      this.treeData = treeData;
      await this.initialize(onProgress);
    }

    async initialize(onProgress?: (nodesBuiltSoFar: number) => void) {
      // Build the tree nodes from Json object. The result is a list of `TodoItemNode` with nested
      //     file node as children.
      const data = await this.buildFileTree(this.treeData, 0, [], { count: 0 }, onProgress);
      this.dataChange.next(data);

    }
  
    /**
     * Build the file structure tree. The `value` is the Json object, or a sub-tree of a Json object.
     * The return value is the list of `TodoItemNode`.
     * 
     * This is the old version of buildFileTree. Because this function is synchronous we created an async
     * version of it. Please also read the comment on buildFileTree for an explanation on why we needed something like this. 
     */
    buildFileTree_(obj: {[key: string]: any}, level: number): TodoItemNode[] {
      return Object.keys(obj).reduce<TodoItemNode[]>((accumulator, key) => {
        const value = obj[key];
        const node = new TodoItemNode();
        node.item = key;
  
        if (value != null) {
          if (typeof value === 'object') {
            node.children = this.buildFileTree_(value, level + 1);
          } else {
            node.item = value;
          }
        }
  
        return accumulator.concat(node);
      }, []);
    }

    /** @param counter shared across the whole recursion (not just this call's own accumulator) - each nested
     *  subtree gets its own fresh `accumulator`, so accumulator.length can't be used as a running total the way
     *  e.g. worker.ts's getAllFiles uses arrayOfFiles.length; this object is threaded through instead so every
     *  recursive call increments the SAME counter. Its running count has no fixed total to compare against on
     *  its own (a nested folder structure's total node count isn't known without a separate pass) - see
     *  FilesTreeComponent.setTreeData for how this is combined with list_to_json's own (exactly known) progress
     *  into one real percentage for the whole setTreeData() call. */
    async buildFileTree(obj: {[key: string]: any}, level: number, accumulator: TodoItemNode[] = [], counter: { count: number } = { count: 0 }, onProgress?: (nodesBuiltSoFar: number) => void): Promise<TodoItemNode[]>{
      for (const [key, value] of Object.entries(obj)) {
        const node = new TodoItemNode();
        node.item = key;
        node.extras = value.extras;


        if (value.children != null) {
          if (typeof value === 'object') {
            node.children = await this.buildFileTree(value.children, level + 1, [], counter, onProgress);
            node.extras = value.extras;
          } else {
            node.item = value;
          }
        }

        //Push instead of concat, more efficient (per AI)
        accumulator.push(node);
        counter.count++;
        if (onProgress && counter.count % TREE_BUILD_PROGRESS_REPORT_INTERVAL === 0) { onProgress(counter.count); }
      }
      /* This is necessary in order for the UI to not freeze.
      This function is going to occupy the single thread for some time.
      By setting a timeout we give the chance for other stuff (like the user pressing the cancel button)
      to be processed. Because we also need this function to finish in a shorter period of time we run this
      timeout only 10% of the iterations or something.
      Note that this is still not an elegant solution and we must (in a future version) try to offload the conputation
      done here to the worker process. But for now, it is what it is.
      */
      const prob = 0.2
      if(Math.random() < prob){
        //Only way (as far as I understand) to make buildFileTree function blocking is to use an await.
        await yieldToEventLoop();
      }
      return accumulator;
    }
  
    /** Add an item to to-do list */
    insertItem(parent: TodoItemNode, name: string) {
      if (parent.children) {
        parent.children.push({item: name} as TodoItemNode);
        this.dataChange.next(this.data);
      }
    }
  
    updateItem(node: TodoItemNode, name: string) {
      node.item = name;
      this.dataChange.next(this.data);
    }
  }
  
  /**
   * @title Tree with checkboxes
   */
  @Component({
    selector: 'files-tree',
    templateUrl: './files-tree.component.html',
    styleUrls: ['./files-tree.component.scss'],
    providers: [ChecklistDatabase]
  })
  export class FilesTreeComponent {
    /** When true, selecting (or deselecting) one part of a large file that was split across multiple pieces
     *  (see PART_FILE_PATTERN below) automatically selects/deselects every OTHER part of that same file too -
     *  so recovering a file split into many pieces (possibly across several discs) only takes one click instead
     *  of one click per part. Only ever meaningful in a recovery context - split-file naming
     *  ("<name>.part.<digits>") only ever shows up there, never in a backup-direction file picker, so this is a
     *  harmless no-op wherever it's left false (the default, for every <files-tree> usage that doesn't opt in). */
    @Input() groupPartialFiles = false;

    /** When true, every checkbox in this tree is disabled - the tree can still be expanded/collapsed and
     *  scrolled to review its contents, but its selection can no longer be changed. Used by
     *  backup-to-optical-media.component.ts to lock a disc's tree once it has been sent to ImgBurn at least
     *  once (see disc-tree-locked in that component's own stylesheet) - a resend just reopens the exact .ibb
     *  file the first send already produced, so a selection change made afterwards would silently have no
     *  effect; this makes that visible instead of confusing, without also preventing the user from still
     *  scrolling through what was actually sent. Defaults to false, so every other <files-tree> usage
     *  (unaffected, opt-in only) behaves exactly as before. */
    @Input() disabled = false;

    /** Emits a real 0-100 percentage while setTreeData() is running (list_to_json + buildFileTree combined -
     *  see setTreeData's own comment for how the two phases are weighted into one number), finishing with a
     *  final emit of exactly 100 once it resolves. Left unlistened-to, this is a no-op - every existing
     *  <files-tree> usage behaves exactly as before. */
    @Output() buildProgress = new EventEmitter<number>();

    /** Matches this app's own large-file split volume naming convention - see PART_FILE_PATTERN in
     *  app/workers/worker.ts and groupSelectedPartialFiles in optical-disc-backup-data-retriever.component.ts,
     *  which this mirrors exactly (kept as its own copy here since this component doesn't otherwise depend on
     *  that one). */
    private static readonly PART_FILE_PATTERN = /^(.+)\.part\.\d+$/i;

    /** Map from flat node to nested node. This helps us finding the nested node to be modified */
    flatNodeMap = new Map<TodoItemFlatNode, TodoItemNode>();
  
    /** Map from nested node to flattened node. This helps us to keep the same object for selection */
    nestedNodeMap = new Map<TodoItemNode, TodoItemFlatNode>();
  
    /** A selected parent node to be inserted */
    selectedParent: TodoItemFlatNode | null = null;
  
    /** The new item's name */
    newItemName = '';
  
    treeControl: FlatTreeControl<TodoItemFlatNode>;
  
    treeFlattener: MatTreeFlattener<TodoItemNode, TodoItemFlatNode>;
  
    dataSource: MatTreeFlatDataSource<TodoItemNode, TodoItemFlatNode>;
  
    /** The selection for checklist */
    checklistSelection = new SelectionModel<TodoItemFlatNode>(true /* multiple */);
  
    constructor(private _database: ChecklistDatabase) {
      this.treeFlattener = new MatTreeFlattener(this.transformer, this.getLevel,
        this.isExpandable, this.getChildren);
      this.treeControl = new FlatTreeControl<TodoItemFlatNode>(this.getLevel, this.isExpandable);
      this.dataSource = new MatTreeFlatDataSource(this.treeControl, this.treeFlattener);
  
      _database.dataChange.subscribe(data => {
        this.dataSource.data = data;
      });
    }

    /** Builds and displays the tree for `treeData` (see list_to_json/buildFileTree for the two real phases this
     *  goes through: flat path list -> nested object, then nested object -> Angular tree nodes). Emits
     *  `buildProgress` (0-100) across the whole call for a caller that wants a real progress bar instead of a
     *  bare spinner while this runs - list_to_json's progress (an exact count against treeData.length) covers
     *  the first half of the range, buildFileTree's (an approximate count - see its own counter param comment,
     *  a tree has more nodes than treeData has leaf paths once directories are counted too) the second half,
     *  capped so it can only ever approach, never reach, 100 on its own - the explicit final emit below is what
     *  actually lands on exactly 100, regardless of how buildFileTree's own approximation landed. */
    async setTreeData(treeData: Array<string>, extras:Array<any>=[]): Promise<void>{
      const total = treeData.length;
      const reportsProgress = total > 0 && this.buildProgress.observed;
      const json = await list_to_json(treeData, extras, reportsProgress
        ? (itemsProcessed) => this.buildProgress.emit(Math.round((itemsProcessed / total) * 50))
        : undefined);
      await this._database.setTreeData(json, reportsProgress
        ? (nodesBuiltSoFar) => this.buildProgress.emit(50 + Math.round((Math.min(nodesBuiltSoFar, total) / total) * 50))
        : undefined);
      if (reportsProgress) { this.buildProgress.emit(100); }
    }
  
    getLevel = (node: TodoItemFlatNode) => node.level;
  
    isExpandable = (node: TodoItemFlatNode) => node.expandable;
  
    getChildren = (node: TodoItemNode): TodoItemNode[] => node.children;
  
    hasChild = (_: number, _nodeData: TodoItemFlatNode) => _nodeData.expandable;
  
    hasNoContent = (_: number, _nodeData: TodoItemFlatNode) => _nodeData.item === '';
  
    /**
     * Transformer to convert nested node to flat node. Record the nodes in maps for later use.
     */
    transformer = (node: TodoItemNode, level: number) => {
      const existingNode = this.nestedNodeMap.get(node);
      const flatNode = existingNode && existingNode.item === node.item
          ? existingNode
          : new TodoItemFlatNode();
      flatNode.item = node.item;
      flatNode.extras = node.extras;
      flatNode.level = level;
      flatNode.expandable = (Array.isArray(node.children))
      this.flatNodeMap.set(flatNode, node);
      this.nestedNodeMap.set(node, flatNode);
      return flatNode;
    }
  
    /** Whether all the descendants of the node are selected. */
    descendantsAllSelected(node: TodoItemFlatNode): boolean {
      const descendants = this.treeControl.getDescendants(node);
      const descAllSelected = descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      return descAllSelected;
    }
  
    /** Whether part of the descendants are selected */
    descendantsPartiallySelected(node: TodoItemFlatNode): boolean {
      const descendants = this.treeControl.getDescendants(node);
      const result = descendants.some(child => this.checklistSelection.isSelected(child));
      return result && !this.descendantsAllSelected(node);
    }
  
    /** Toggle the to-do item selection. Select/deselect all the descendants node */
    todoItemSelectionToggle(node: TodoItemFlatNode): void {
      this.checklistSelection.toggle(node);
      const descendants = this.treeControl.getDescendants(node);
      this.checklistSelection.isSelected(node)
        ? this.checklistSelection.select(...descendants)
        : this.checklistSelection.deselect(...descendants);
  
      // Force update for the parent
      descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      this.checkAllParentsSelection(node);
    }
  
    /** Toggle a leaf to-do item selection. Check all the parents to see if they changed */
    todoLeafItemSelectionToggle(node: TodoItemFlatNode): void {
      this.checklistSelection.toggle(node);
      if (this.groupPartialFiles) {
        this.toggleSiblingPartialFiles(node);
      }
      this.checkAllParentsSelection(node);
    }

    /** When groupPartialFiles is on and `node` is one part of a split large file (PART_FILE_PATTERN), selects
     *  or deselects every OTHER part of that same file to match `node`'s own just-toggled state - e.g. checking
     *  any one of "video.mp4.part.001" .. "video.mp4.part.025" checks the whole set in one click. Siblings are
     *  looked for among the toggled node's own parent's children (via flatNodeMap/nestedNodeMap, or the
     *  top-level nodes if there is no parent) - the app's own split-file convention always puts every part of a
     *  file in the very same folder (see partitionBackupToOpticalMedia in worker.ts), so this is always a
     *  same-parent search, never a whole-tree scan. */
    private toggleSiblingPartialFiles(node: TodoItemFlatNode): void {
      const match = FilesTreeComponent.PART_FILE_PATTERN.exec(node.item);
      if (!match) { return; }
      const baseName = match[1];
      const nowSelected = this.checklistSelection.isSelected(node);

      const parentFlat = this.getParentNode(node);
      const siblingNestedNodes = parentFlat ? (this.flatNodeMap.get(parentFlat)?.children ?? []) : this._database.data;

      for (const nestedSibling of siblingNestedNodes) {
        const siblingFlat = this.nestedNodeMap.get(nestedSibling);
        if (!siblingFlat || siblingFlat === node || siblingFlat.expandable) { continue; }
        const siblingMatch = FilesTreeComponent.PART_FILE_PATTERN.exec(siblingFlat.item);
        if (!siblingMatch || siblingMatch[1] !== baseName) { continue; }
        if (nowSelected) {
          this.checklistSelection.select(siblingFlat);
        } else {
          this.checklistSelection.deselect(siblingFlat);
        }
      }
    }
  
    /* Checks all the parents when a leaf node is selected/unselected */
    checkAllParentsSelection(node: TodoItemFlatNode): void {
      let parent: TodoItemFlatNode | null = this.getParentNode(node);
      while (parent) {
        this.checkRootNodeSelection(parent);
        parent = this.getParentNode(parent);
      }
    }
  
    /** Check root node checked state and change it accordingly */
    checkRootNodeSelection(node: TodoItemFlatNode): void {
      const nodeSelected = this.checklistSelection.isSelected(node);
      const descendants = this.treeControl.getDescendants(node);
      const descAllSelected = descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      if (nodeSelected && !descAllSelected) {
        this.checklistSelection.deselect(node);
      } else if (!nodeSelected && descAllSelected) {
        this.checklistSelection.select(node);
      }
    }
  
    /* Get the parent node of a node */
    getParentNode(node: TodoItemFlatNode): TodoItemFlatNode | null {
      const currentLevel = this.getLevel(node);
  
      if (currentLevel < 1) {
        return null;
      }
  
      const startIndex = this.treeControl.dataNodes.indexOf(node) - 1;
  
      for (let i = startIndex; i >= 0; i--) {
        const currentNode = this.treeControl.dataNodes[i];
  
        if (this.getLevel(currentNode) < currentLevel) {
          return currentNode;
        }
      }
      return null;
    }
  
    /** Select the category so we can insert the new item. */
    addNewItem(node: TodoItemFlatNode) {
      const parentNode = this.flatNodeMap.get(node);
      this._database.insertItem(parentNode!, '');
      this.treeControl.expand(node);
    }
  
    /** Save the node to database */
    saveNode(node: TodoItemFlatNode, itemValue: string) {
      const nestedNode = this.flatNodeMap.get(node);
      this._database.updateItem(nestedNode!, itemValue);
    }

    /** Expanding one node at a time (the old implementation here: `dataNodes.forEach(node =>
     *  treeControl.expand(node))`) is an O(N^2) trap for a tree this size: MatTreeFlatDataSource recomputes
     *  which nodes are visible - a full pass over EVERY node in the tree - on every single expansion-model
     *  change (see its connect(), which re-derives _expandedData from expansionModel.changed). Expanding N
     *  nodes one at a time therefore triggers N of those full-tree passes. FlatTreeControl's own expandAll()
     *  selects every node into the expansion model in one batched call instead, so the same end state (every
     *  node expanded) costs one full-tree pass, not N of them - the difference between a tree of a few hundred
     *  thousand files loading in a moment versus never finishing. */
    expandAllNodes(){
      this.treeControl.expandAll();
    }

    /** See expandAllNodes' comment - collapseAll() is the same one-batched-call fix, in reverse. */
    collapseAllNodes(){
      this.treeControl.collapseAll();
    }

    selectAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.checklistSelection.select(node); 
      })
    }

    deselectAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.checklistSelection.deselect(node); 
      })
    }

    isEmptyDir(node: TodoItemFlatNode){
      return !this.treeControl.getDescendants(node).length;
    }

    add_folder(folder: string, prefix: any): void {
      prefix.str += folder + "\\";
      ++prefix.level;
    }

    remove_folder(prefix: any): void {
      for (let i = prefix.str.length - 2; i >= 0; --i) {
        if (prefix.str[i] == '\\') {
          prefix.str = prefix.str.substring(0, i + 1);
          --prefix.level;
          return;
        }
      }
      // moving to "root" directory (ex "C\\Users" where the "C" has no "\" before it)
      prefix.str = "";
      --prefix.level;
    }

    getSelectedData(): Array<string> {
      let selectedPaths: Array<string> = [];
      let prefix = { str: "", level: 0 };
      this.treeControl.dataNodes.forEach((node) => {
        let level_difference = prefix.level - node.level;
        if (level_difference > 0) {
          for (let i = 0; i < level_difference; ++i) {
            this.remove_folder(prefix);
          }
          level_difference = prefix.level - node.level;
        }
        if (node.expandable) {
          // "folder"
          if(this.isEmptyDir(node)){
            if (this.checklistSelection.isSelected(node)) {
              //console.log("[selected]:" + prefix.str + node.item + "\\");
              selectedPaths.push(prefix.str + node.item + "\\");
            }
          }else{
            if (level_difference <= 0) {
              this.add_folder(node.item, prefix);
            }
          }
        } else {
          if (this.checklistSelection.isSelected(node)) {
            // "file"
            //console.log("[selected]:" + prefix.str + node.item);
            selectedPaths.push(prefix.str + node.item);
          }
        }
      })
      return selectedPaths;
    }


    getSelectedFilePathsIncludingExtraInfo(): Array<{"path":string, extras:any}> {
      let selectedPaths: Array<{"path":string, extras:any}> = [];
      let prefix = { str: "", level: 0 };
      this.treeControl.dataNodes.forEach((node) => {
        let level_difference = prefix.level - node.level;
        if (level_difference > 0) {
          for (let i = 0; i < level_difference; ++i) {
            this.remove_folder(prefix);
          }
          level_difference = prefix.level - node.level;
        }
        if (node.expandable) {
          // "folder"
          if(this.isEmptyDir(node)){
            if (this.checklistSelection.isSelected(node)) {
              //console.log("[selected]:" + prefix.str + node.item + "\\");
              selectedPaths.push({
                "path": prefix.str + node.item + "\\",
                "extras": node.extras
              });
            }
          }else{
            if (level_difference <= 0) {
              this.add_folder(node.item, prefix);
            }
          }
        } else {
          if (this.checklistSelection.isSelected(node)) {
            // "file"
            //console.log("[selected]:" + prefix.str + node.item);
            selectedPaths.push({
              "path": prefix.str + node.item,
              "extras": node.extras
            });
          }
        }
      })
      return selectedPaths;
    }


  }